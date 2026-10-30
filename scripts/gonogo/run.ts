// Judge go/no-go (ROADMAP T0.3): records the ten fixture clips, asks both judges about each with
// the judge.v1 prompt, applies the §22.3 rule and prints the GO / NO-GO decision.
//   pnpm gonogo                 record what's missing, judge what isn't cached, score
//   pnpm gonogo --dry-run       record and write the bundles, but call no model
//   pnpm gonogo --effort=low    set reasoning_effort on both judges (answers cached separately)
//   pnpm gonogo --only=id,id    only these clips (a partial run is not a decision)
//   pnpm gonogo --rerecord      record every clip again (new clips mean new, billed judge calls)
//   pnpm gonogo --rejudge       ignore cached answers and ask again (billed)
// Judge calls are real and billed, about $0.01 each and 20 for a full run. Keys come from .env.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

import { chromium } from "playwright";
import { z } from "zod";

import { loadDotEnv, REPO_ROOT } from "../probe/lib/env.ts";
import { dataUrl } from "../probe/models/meta-api.ts";
import { CLIPS, type Clip } from "./clips.ts";
import { startShop } from "./fixture/server.ts";
import { checkJudge, combine, combineR13 } from "./lib/combine.ts";
import { annotateShot, boxesAtShot, encodeJudgeVideo } from "./lib/encode.ts";
import {
  callJudge,
  costUsd,
  judgeSpecs,
  requestBody,
  type Effort,
  type JudgeCall,
  type JudgeSpec,
} from "./lib/judge.ts";
import { JUDGE_PROMPT_VERSION, renderBundle } from "./lib/prompt.ts";
import { recordClip } from "./lib/record.ts";
import { formatTable, summarize, type ClipResult, type JudgeResult } from "./lib/report.ts";
import { JudgeOutput, Lane } from "./lib/schema.ts";

const OUT = `${REPO_ROOT}probes/gonogo/`;
const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh"];
/** Hard cap on HTTP requests per run (20 calls plus retries), so nothing can loop on credits. */
const MAX_REQUESTS = 60;
const EST_USD_PER_CALL = 0.01;

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const option = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const effort = option("effort") as Effort | undefined;
const only = option("only")?.split(",");
const clips = CLIPS.filter((c) => !only || only.includes(c.id));
if (effort && !EFFORTS.includes(effort)) usage(`--effort must be one of ${EFFORTS.join(", ")}`);
if (only && clips.length !== only.length) usage(`unknown clip in --only`);

loadDotEnv();
mkdirSync(`${OUT}judgements`, { recursive: true });
const clipDir = (clip: Clip): string => `${OUT}clips/${clip.id}/`;

// 1. Record (local and free). Clips already on disk are reused, so their judge answers stay cached.
const lanes = await recordAll(flag("rerecord"));

// 2. The §22.2 bundle per clip, and one request per judge.
const specs = judgeSpecs();
const bodies = new Map(
  clips.map((clip) => {
    const dir = clipDir(clip);
    const bundle = renderBundle(clip.criterion, lanes.get(clip.id)!);
    writeFileSync(`${dir}bundle.txt`, `${bundle}\n`);
    const media = {
      imageUrl: dataUrl(`${dir}annotated.png`, "image/png"),
      videoUrl: dataUrl(`${dir}judge.mp4`, "video/mp4"),
    };
    return [clip.id, specs.map((spec) => requestBody(spec, bundle, media, effort))] as const;
  }),
);
const tag = effort ?? "default";
const judgementFile = (clip: Clip, spec: JudgeSpec): string =>
  `${OUT}judgements/${clip.id}.${spec.key}.${tag}.json`;
const keyOf = (spec: JudgeSpec, body: unknown): string =>
  createHash("sha256").update(spec.url).update(JSON.stringify(body)).digest("hex");

const Cached = z.object({ key: z.string(), call: z.custom<JudgeCall>() });
function cachedCall(clip: Clip, spec: JudgeSpec, key: string): JudgeCall | null {
  const file = judgementFile(clip, spec);
  if (flag("rejudge") || !existsSync(file)) return null;
  const saved = Cached.parse(JSON.parse(readFileSync(file, "utf8")));
  if (saved.key !== key) return null; // the prompt, media, model or effort changed
  JudgeOutput.nullable().parse(saved.call.output);
  return saved.call;
}

const pending = clips.flatMap((clip) =>
  specs.flatMap((spec, n) =>
    cachedCall(clip, spec, keyOf(spec, bodies.get(clip.id)![n])) ? [] : [{ clip, spec }],
  ),
);
console.log(
  `\n${clips.length} clip(s) ready in probes/gonogo/clips/. ${pending.length} judge call(s) needed` +
    `${pending.length ? ` (about $${(pending.length * EST_USD_PER_CALL).toFixed(2)})` : ""}; the rest are cached.`,
);

if (flag("dry-run")) {
  const first = clips[0]!;
  console.log(`\nDry run: no model calls. Bundles are in probes/gonogo/clips/*/bundle.txt.`);
  for (const clip of clips) {
    const dir = clipDir(clip);
    const kb = (f: string) => Math.round(statSync(`${dir}${f}`).size / 1024);
    console.log(
      `  ${clip.id.padEnd(24)} judge.mp4 ${kb("judge.mp4")} KB, annotated.png ${kb("annotated.png")} KB`,
    );
  }
  console.log(
    `\n--- ${first.id}/bundle.txt ---\n${readFileSync(`${clipDir(first)}bundle.txt`, "utf8")}`,
  );
  process.exit(0);
}

const missingKeys = [...new Set(pending.map((p) => p.spec))].filter((s) => !s.apiKey);
if (missingKeys.length > 0) {
  console.error(
    `\nMissing keys: ${missingKeys.map((s) => s.keyVar).join("; ")}. See .env.example.`,
  );
  process.exit(2);
}

// 3. Judge: clips one at a time, both judges in parallel (§19), cached by request hash.
let requests = 0;
const results: ClipResult[] = [];
console.log(`\nJudging with ${JUDGE_PROMPT_VERSION}, reasoning_effort ${tag}:`);
for (const clip of clips) {
  if (requests >= MAX_REQUESTS) {
    console.error(`Stopped: ${requests} requests this run (cap ${MAX_REQUESTS}).`);
    break;
  }
  const lane = lanes.get(clip.id)!;
  const judges = (await Promise.all(
    specs.map(async (spec, n): Promise<JudgeResult> => {
      const body = bodies.get(clip.id)![n]!;
      const key = keyOf(spec, body);
      const cached = cachedCall(clip, spec, key);
      const call = cached ?? (await callJudge(spec, body));
      if (!cached) {
        requests += call.requests;
        const saved = { key, model: spec.model, prompt: JUDGE_PROMPT_VERSION, effort: tag, call };
        writeFileSync(judgementFile(clip, spec), `${JSON.stringify(saved, null, 2)}\n`);
      }
      return {
        key: spec.key,
        name: spec.name,
        output: call.output,
        checked: checkJudge(call.output, clip.criterion, lane.readings),
        ...(call.error && { error: call.error }),
        ms: call.ms,
        requests: call.requests,
        usage: call.usage,
        costUsd: costUsd(call.usage),
        cached: cached !== null,
      };
    }),
  )) as [JudgeResult, JudgeResult];
  const [a, b] = judges;
  const result: ClipResult = {
    id: clip.id,
    label: clip.label,
    truth: clip.truth,
    judges,
    final: combine(a.checked, b.checked),
    r13: combineR13(a.checked, b.checked),
    verdictMs: Math.max(a.ms, b.ms),
  };
  results.push(result);
  const errors = judges.flatMap((j) => (j.error ? [`${j.name}: ${j.error}`] : []));
  console.log(
    `  ${clip.id}: ${result.final.verdict} (${result.final.reason})${errors.length ? `  ! ${errors.join("; ")}` : ""}`,
  );
}

// 4. Report.
const summary = summarize(results);
const all = results.flatMap((r) => r.judges);
const sum = (pick: (j: JudgeResult) => number) => all.reduce((t, j) => t + pick(j), 0);
const fresh = all.filter((j) => !j.cached);
const spend = {
  newCalls: fresh.length,
  requests,
  newUsd: fresh.reduce((t, j) => t + j.costUsd, 0),
  allUsd: sum((j) => j.costUsd),
  promptTokens: sum((j) => j.usage.promptTokens),
  cachedTokens: sum((j) => j.usage.cachedTokens),
  completionTokens: sum((j) => j.usage.completionTokens),
  reasoningTokens: sum((j) => j.usage.reasoningTokens),
};
const complete = results.length === CLIPS.length;
console.log(`\n${formatTable(results).join("\n")}`);
console.log(
  `  (A→✗cite: a decided verdict whose citation failed valueMatches; →✗target: wrong target)\n`,
);
console.log(summary.lines.join("\n"));
console.log(
  `\nSpend: ${spend.newCalls} new call(s), ${spend.requests} request(s) this run ≈ $${spend.newUsd.toFixed(4)}. ` +
    `All ${all.length} answers: ${spend.promptTokens} prompt tokens (${spend.cachedTokens} cached), ` +
    `${spend.completionTokens} output tokens (${spend.reasoningTokens} reasoning) ≈ $${spend.allUsd.toFixed(4)}.`,
);
console.log(
  complete
    ? `\nDECISION: ${summary.go ? "GO" : "NO-GO"}`
    : `\nPartial run (${results.length} of ${CLIPS.length} clips): not a decision.`,
);
const resultsFile = `${OUT}results${effort ? `-${effort}` : ""}.json`;
const report = {
  at: new Date().toISOString(),
  prompt: JUDGE_PROMPT_VERSION,
  effort: tag,
  complete,
  go: summary.go,
  strict: summary.strict,
  r13: summary.r13,
  judges: summary.judges,
  spend,
  clips: results,
};
writeFileSync(resultsFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${resultsFile.slice(REPO_ROOT.length)}`);

async function recordAll(rerecord: boolean): Promise<Map<string, Lane>> {
  const done = (c: Clip) =>
    ["lane.json", "judge.mp4", "annotated.png"].every((f) => existsSync(`${clipDir(c)}${f}`));
  const lanes = new Map<string, Lane>();
  const todo = clips.filter((c) => rerecord || !done(c));
  for (const clip of clips.filter((c) => !todo.includes(c))) {
    lanes.set(clip.id, Lane.parse(JSON.parse(readFileSync(`${clipDir(clip)}lane.json`, "utf8"))));
  }
  if (todo.length === 0) return lanes;
  console.log(`Recording ${todo.length} clip(s) on the fixture shop…`);
  const shop = await startShop();
  const browser = await chromium.launch();
  try {
    for (const clip of todo) {
      const dir = clipDir(clip);
      mkdirSync(dir, { recursive: true });
      const lane = await recordClip(browser, shop.origin, clip, {
        videoDir: dir,
        shotPath: `${dir}shot.png`,
      });
      await encodeJudgeVideo(browser, `${dir}raw.webm`, `${dir}judge.mp4`, `${dir}frames`);
      await annotateShot(browser, `${dir}shot.png`, boxesAtShot(lane), `${dir}annotated.png`);
      writeFileSync(`${dir}lane.json`, `${JSON.stringify(lane, null, 2)}\n`);
      lanes.set(clip.id, lane);
      console.log(`  ${clip.id} (${clip.variant})`);
    }
  } finally {
    await browser.close();
    await shop.close();
  }
  return lanes;
}

function usage(problem: string): never {
  console.error(`${problem}\nClips: ${CLIPS.map((c) => c.id).join(", ")}`);
  process.exit(2);
}
