// `pnpm bench:judge`: IntentBench's phase 2, "judge many" (ARCHITECTURE §31, T6.3). Every
// criterion of the split's cases is judged from its frozen pack by each arm (arms.ts), with §19 e's
// re-record rule on the two PR takes, and the rows go to bench/results/ for the analysis (T6.4).
//
//   pnpm bench:judge --split=heldout [--arms=A,B,C,D] [--repeats=3] [--d-repeats=2]
//                    [--only=<case id prefix>] [--max-usd=2.5] [--out=<file>]
//
// Arms A–C are judged by Spark 1.3 alone; arm D by both judges (Spark Open on Baseten and Spark
// 1.3), which also gives each model's own verdict. It stops before any call that would take the
// spend past --max-usd, and says so in the results. Needs META_API_KEY, and BASETEN_API_KEY for
// arm D, in .env, the packs (pnpm bench:record) and ffmpeg (arm C's stills).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Criterion, LaneResult } from "@intenzo/core";
import {
  afterRerecord,
  checkJudge,
  JUDGE_JSON_SCHEMA,
  JUDGE_SYSTEM,
  JUDGE_V1,
  judgeCriterion,
  JudgeReply,
  judgesFromEnv,
  preJudge,
  rerecordFor,
  type Judge,
  type Judged,
  type JudgeSide,
} from "@intenzo/core/judge";
import { costUsd, type ContentPart, type ModelPort } from "@intenzo/core/models";

import {
  ARMS,
  asVerdict,
  confirmLone,
  DIFF_JSON_SCHEMA,
  DIFF_V1,
  diffMessages,
  DiffReply,
  diffVerdict,
  FRAME_FPS,
  framesParts,
  MAX_FRAMES,
  readingsParts,
  type Arm,
  type BenchVerdict,
} from "./arms.ts";
import { loadCases, loadTicket, type BenchCase } from "./case.ts";
import {
  MANIFEST_FILE,
  PACKS_DIR,
  packDir,
  readDiff,
  readPack,
  type Manifest,
  type Pack,
  type Take,
} from "./pack.ts";
import { mergeRedo, Results, unitKey, unitsWith, type ResultRow } from "./results.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const RESULTS_DIR = new URL("../../results/", import.meta.url).pathname;
const MAX_TOKENS = 8192;
const TIMEOUT_MS = 90_000;

// ── Lone-judge calls (arms A–C) ──────────────────────────────────────────────────────────────

interface Spent {
  calls: number;
  usd: number;
  ms: number;
}
const add = (a: Spent, b: Spent): Spent => ({
  calls: a.calls + b.calls,
  usd: a.usd + b.usd,
  ms: a.ms + b.ms,
});
const NONE: Spent = { calls: 0, usd: 0, ms: 0 };

/** §22.1's caps for a lone judge: a missing trigger can't pass, and no isolation caps it. */
export function capLone(
  v: BenchVerdict,
  lane: Pick<LaneResult, "status" | "isolation">,
): BenchVerdict {
  if (v.verdict === "inconclusive") return v;
  if (lane.status === "trigger_absent" && v.verdict === "pass")
    return { verdict: "inconclusive", reason: "precondition_unmet" };
  if (lane.isolation === "none") return { verdict: "inconclusive", reason: "no_isolation" };
  return v;
}

async function judgeAlone(
  judge: Judge,
  criterion: Criterion,
  lane: LaneResult,
  parts: ContentPart[],
): Promise<{ verdict: BenchVerdict; spent: Spent }> {
  const pre = preJudge(criterion, lane);
  if (pre) return { verdict: pre, spent: NONE };
  const r = await judge.port.call({
    stage: "bench-judge",
    model: judge.model,
    promptVersion: JUDGE_V1,
    messages: [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: parts },
    ],
    schema: JudgeReply,
    jsonSchema: { name: "JudgeOutput", schema: JUDGE_JSON_SCHEMA },
    maxTokens: MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
    reasoningEffort: "low",
  });
  const checked = checkJudge(r.ok ? r.output : null, criterion, lane.readings);
  return {
    verdict: capLone(asVerdict(checked), lane),
    spent: { calls: r.requests, usd: costUsd(judge.model, r.usage) ?? 0, ms: r.ms },
  };
}

// ── Arm C's stills ───────────────────────────────────────────────────────────────────────────

/** The judge video's stills at 2 fps (cached outside the pack, which is hashed in the manifest). */
export function stillsOf(video: string, key: string): string[] {
  const dir = join(tmpdir(), "intentbench-frames", key);
  if (!existsSync(dir) || readdirSync(dir).length === 0) {
    mkdirSync(dir, { recursive: true });
    const r = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      video,
      "-vf",
      `fps=${FRAME_FPS}`,
      "-frames:v",
      String(MAX_FRAMES),
      "-q:v",
      "4",
      join(dir, "%02d.jpg"),
    ]);
    if (r.status !== 0)
      throw new Error(
        `ffmpeg couldn't cut stills from ${video}: ${r.stderr.toString().slice(0, 200)}`,
      );
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => join(dir, f));
}

// ── One criterion ────────────────────────────────────────────────────────────────────────────

interface Unit {
  case: BenchCase;
  criterion: Criterion;
  ticketText: string;
  pack: Pack;
  sha: string;
}

type Row = Omit<ResultRow, "caseId" | "criterionId" | "kind" | "split" | "label" | "pack">;

const takeFile = (u: Unit, take: string, file: string | null) =>
  file ? join(packDir(PACKS_DIR, u.case.id, u.criterion.id), take, file) : undefined;

function side(u: Unit, takeName: string, take: Take): JudgeSide {
  const judgeVideo = takeFile(u, takeName, take.judgeVideo);
  const annotatedShot = takeFile(u, takeName, take.annotatedShot);
  return {
    lane: take.lane,
    ...(judgeVideo && { judgeVideo }),
    ...(annotatedShot && { annotatedShot }),
  };
}

const noTakes = (arm: Arm, repeat: number, reason: "setup_failed"): Row[] =>
  (arm === "D" ? (["dual", "spark-open", "spark-1.3"] as const) : (["spark-1.3"] as const)).map(
    (judge) => ({
      arm,
      judge,
      repeat,
      verdict: "inconclusive",
      reason,
      rerecorded: false,
      ...NONE,
    }),
  );

async function armA(u: Unit, spark: ModelPort, repeat: number): Promise<Row[]> {
  const diff = readDiff(PACKS_DIR, u.case.id);
  if (!diff) throw new Error(`no diff.json for ${u.case.id}: record it first`);
  const r = await spark.call({
    stage: "bench-judge",
    model: "muse-spark-1.3",
    promptVersion: DIFF_V1,
    messages: diffMessages(u.ticketText, u.criterion, diff),
    schema: DiffReply,
    jsonSchema: { name: "DiffVerdict", schema: DIFF_JSON_SCHEMA },
    maxTokens: MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
    reasoningEffort: "low",
  });
  const v = diffVerdict(r.ok ? r.output : null);
  return [
    {
      arm: "A",
      judge: "spark-1.3",
      repeat,
      ...v,
      rerecorded: false,
      calls: r.requests,
      usd: costUsd("muse-spark-1.3", r.usage) ?? 0,
      ms: r.ms,
    },
  ];
}

/** Arms B and C: Spark 1.3 alone on PR take 1, and on take 2 to confirm a fail (§19 e). */
async function armBC(arm: "B" | "C", u: Unit, spark: Judge, repeat: number): Promise<Row[]> {
  const takes = u.pack.takes!;
  const parts = (k: 0 | 1) => {
    const pr = takes.pr[k].lane;
    if (arm === "B") return readingsParts(u.criterion, pr, takes.base.lane);
    const video = takeFile(u, `pr-${k + 1}`, takes.pr[k].judgeVideo);
    const stills = video ? stillsOf(video, `${u.sha.slice(0, 16)}-pr-${k + 1}`) : [];
    return framesParts(u.criterion, pr, takes.base.lane, stills);
  };
  const first = await judgeAlone(spark, u.criterion, takes.pr[0].lane, parts(0));
  let spent = first.spent;
  let second: BenchVerdict | null = null;
  if (first.verdict.verdict === "fail") {
    const again = await judgeAlone(spark, u.criterion, takes.pr[1].lane, parts(1));
    second = again.verdict;
    spent = add(spent, again.spent);
  }
  return [
    {
      arm,
      judge: "spark-1.3",
      repeat,
      ...confirmLone(first.verdict, second),
      rerecorded: second !== null,
      ...spent,
    },
  ];
}

const spentOf = (judged: Judged): Spent =>
  judged.calls.reduce(
    (s, c) => add(s, { calls: 1, usd: costUsd(c.model, c.usage) ?? 0, ms: c.ms }),
    NONE,
  );

/**
 * Arm D: the product's own judging (both judges, §22.3) with §19 e's re-record. Each model's own
 * verdict comes from the same calls; it uses take 2 only when the dual rule re-recorded.
 */
async function armD(u: Unit, judges: readonly [Judge, Judge], repeat: number): Promise<Row[]> {
  const takes = u.pack.takes!;
  const base = side(u, "base", takes.base);
  const first = await judgeCriterion(judges, u.criterion, side(u, "pr-1", takes.pr[0]), base);
  let spent = spentOf(first);
  let second: Judged | null = null;
  if (rerecordFor(first.combined)) {
    second = await judgeCriterion(judges, u.criterion, side(u, "pr-2", takes.pr[1]), base);
    spent = add(spent, spentOf(second));
  }
  const dual = second
    ? afterRerecord(first.combined, first.checked, second.combined)
    : first.combined;
  const alone = (k: 0 | 1, judge: "spark-open" | "spark-1.3"): Row => {
    const v = capLone(asVerdict(first.checked[k]), takes.pr[0].lane);
    const again = second ? capLone(asVerdict(second.checked[k]), takes.pr[1].lane) : null;
    return {
      arm: "D",
      judge,
      repeat,
      ...confirmLone(v, again),
      rerecorded: second !== null,
      ...NONE,
    };
  };
  return [
    { arm: "D", judge: "dual", repeat, ...dual, rerecorded: second !== null, ...spent },
    alone(0, "spark-open"),
    alone(1, "spark-1.3"),
  ];
}

// ── The run ──────────────────────────────────────────────────────────────────────────────────

export interface JudgeArgs {
  split: "tuning" | "heldout";
  arms: Arm[];
  repeats: number;
  dRepeats: number;
  only?: string;
  maxUsd: number;
  out?: string;
  /** A results file whose contradicts_readings units are judged again (and replaced). */
  redo?: string;
}

export function parseJudgeArgs(argv: readonly string[]): JudgeArgs {
  const arg = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const split = arg("split") ?? "heldout";
  if (split !== "heldout" && split !== "tuning") throw new Error("--split is heldout or tuning");
  const arms = (arg("arms") ?? ARMS.join(",")).split(",").map((a) => a.trim().toUpperCase());
  for (const a of arms)
    if (!(ARMS as readonly string[]).includes(a)) throw new Error(`unknown arm ${a}`);
  const int = (name: string, fallback: number) => {
    const n = Number(arg(name) ?? fallback);
    if (!Number.isInteger(n) || n < 1 || n > 5)
      throw new Error(`--${name} is a whole number from 1 to 5`);
    return n;
  };
  const maxUsd = Number(arg("max-usd") ?? 2.5);
  if (!(maxUsd > 0)) throw new Error("--max-usd must be above 0");
  const only = arg("only");
  const out = arg("out");
  const redo = arg("redo");
  return {
    split,
    arms: arms as Arm[],
    repeats: int("repeats", 3),
    dRepeats: int("d-repeats", 2),
    maxUsd,
    ...(only && { only }),
    ...(out && { out }),
    ...(redo && { redo }),
  };
}

export async function runJudge(
  args: JudgeArgs,
  /** Only these units (unitKey) are judged; the rest are skipped without a call. */
  only?: ReadonlySet<string>,
): Promise<Results> {
  const judges = judgesFromEnv();
  const spark = judges?.[1];
  if (!spark) throw new Error("META_API_KEY and BASETEN_API_KEY must be in .env");
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as Manifest;
  const sha = (caseId: string, criterionId: string) =>
    manifest.rows.find((r) => r.case === caseId && r.criterion === criterionId)?.sha256 ?? "";

  const units: Unit[] = [];
  for (const c of loadCases().filter(
    (c) => c.split === args.split && (!args.only || c.id.startsWith(args.only)),
  )) {
    const ticket = loadTicket(c.ticket);
    for (const criterion of ticket.criteria) {
      const pack = readPack(PACKS_DIR, c.id, criterion.id);
      if (!pack)
        throw new Error(`no pack for ${c.id} ${criterion.id}: run pnpm bench:record first`);
      units.push({
        case: c,
        criterion,
        ticketText: ticket.text,
        pack,
        sha: sha(c.id, criterion.id),
      });
    }
  }

  const startedAt = new Date().toISOString();
  const rows: ResultRow[] = [];
  let total = NONE;
  let stoppedAtCap = false;
  // The most one unit of an arm can cost, so a run never starts a call it can't afford.
  const worst: Record<Arm, number> = { A: 0.01, B: 0.01, C: 0.03, D: 0.04 };

  outer: for (const arm of args.arms) {
    const repeats = arm === "D" ? args.dRepeats : args.repeats;
    for (let repeat = 1; repeat <= repeats; repeat++) {
      for (const u of units) {
        if (
          only &&
          !only.has(unitKey({ arm, caseId: u.case.id, criterionId: u.criterion.id, repeat }))
        )
          continue;
        if (total.usd + worst[arm] > args.maxUsd) {
          stoppedAtCap = true;
          break outer;
        }
        let made: Row[];
        if (arm === "A") made = await armA(u, spark.port, repeat);
        else if (!u.pack.takes) made = noTakes(arm, repeat, "setup_failed");
        else if (arm === "D") made = await armD(u, judges, repeat);
        else made = await armBC(arm, u, spark, repeat);
        for (const r of made) {
          total = add(total, { calls: r.calls, usd: r.usd, ms: r.ms });
          rows.push({
            ...r,
            caseId: u.case.id,
            criterionId: u.criterion.id,
            kind: u.case.kind,
            split: u.case.split,
            label: u.case.labels[u.criterion.id]!,
            pack: u.sha,
          });
        }
        const head = made[0]!;
        console.log(
          `${arm} r${repeat} ${u.case.id} ${u.criterion.id}: ${head.verdict} (${head.reason}) label ${u.case.labels[u.criterion.id]} · $${total.usd.toFixed(3)}`,
        );
      }
    }
  }
  return Results.parse({
    startedAt,
    split: args.split,
    arms: args.arms,
    repeats: { ABC: args.repeats, D: args.dRepeats },
    rows,
    totals: {
      calls: total.calls,
      usd: Math.round(total.usd * 1e4) / 1e4,
      ms: Math.round(total.ms),
    },
    stoppedAtCap,
  });
}

if (import.meta.main) {
  process.loadEnvFile(`${ROOT}.env`);
  const args = parseJudgeArgs(process.argv.slice(2));
  const started = Date.now();
  let results: Results;
  let out =
    args.out ?? join(RESULTS_DIR, `judge-${args.split}${args.only ? `-${args.only}` : ""}.json`);
  if (args.redo) {
    // Judge again only the units the §22.3 checks refused for contradicting the readings: the
    // citation check was too strict before #128.
    const first = Results.parse(JSON.parse(readFileSync(args.redo, "utf8")));
    const units = unitsWith(first, "contradicts_readings");
    console.log(`re-judging ${units.size} units of ${args.redo}`);
    const redo = await runJudge(
      {
        ...args,
        split: first.split,
        arms: first.arms,
        repeats: first.repeats.ABC,
        dRepeats: first.repeats.D,
      },
      units,
    );
    results = mergeRedo(
      first,
      redo,
      units,
      "contradicts_readings, judged before #128's citation fix",
    );
    out = args.out ?? args.redo;
  } else {
    results = await runJudge(args);
  }
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  const t = results.totals;
  console.log(
    `\n${results.rows.length} rows · ${t.calls} calls · $${t.usd.toFixed(3)} · ${((Date.now() - started) / 60000).toFixed(1)} min wall` +
      `${results.stoppedAtCap ? ` · STOPPED at the $${args.maxUsd} cap` : ""}\n→ ${out}`,
  );
}
