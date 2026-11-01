import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LaneResult } from "@intenzo/core";
import { type Judge, SPARK_13_MODEL, SPARK_OPEN_MODEL } from "@intenzo/core/judge";
import {
  type ContentPart,
  type ModelPort,
  type ModelRequest,
  type ModelResult,
  NO_USAGE,
} from "@intenzo/core/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JudgeName } from "./arms.ts";
import { loadCases, loadTicket } from "./case.ts";
import { type BenchItem, judgeAll, judgeItem, type Judging } from "./judging.ts";
import { Pack, packDir } from "./pack.ts";
import {
  BenchResults,
  formatResults,
  itemKey,
  type BenchVerdict,
  stillCurrent,
  tally,
} from "./results.ts";

const T0 = 1_793_000_000_000;
const TT = T0 + 1000;
const benchCase = loadCases().find((c) => c.id === "discount-almost-right")!;
const ticket = loadTicket("discount");
const C2 = ticket.criteria.find((c) => c.id === "C2")!;

// 1,000 prompt and 100 output tokens at Spark's list price ($1.25 / $4.25 per million).
const USAGE = { promptTokens: 1000, cachedTokens: 0, completionTokens: 100, reasoningTokens: 60 };
const PER_CALL = 0.001675;
const fail = {
  verdict: "fail",
  targetCorrect: true,
  citedReadings: [1],
  citedValue: "$50.00",
  atMs: 2000,
  observed: "The total stayed $50.00.",
};
const pass = { ...fail, verdict: "pass", observed: "The total read $50.00." };
// Cites a value the reading doesn't hold: §22.3 makes it contradicts_readings.
const miscited = { ...fail, citedValue: "$45.00" };

const review = { verdict: "pass", citedFile: "lib/discount.ts", citedCode: "0.1", observed: "" };
/** Arm A gets a review, the other arms a judge's answer. */
const passing = (request: ModelRequest<unknown>) =>
  request.promptVersion === "review.v1" ? review : pass;

/**
 * A judge that gives its answers in turn ("down": no answer), Spark Open in 4 s, 1.3 in 9 s. Like
 * the real port, a reply that doesn't fit the request's schema is no answer.
 */
function judgeWith(name: JudgeName, answers: unknown[] | typeof passing) {
  const requests: ModelRequest<unknown>[] = [];
  const port: ModelPort = {
    async call<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
      const n = requests.push(request as ModelRequest<unknown>) - 1;
      const answer =
        typeof answers === "function" ? answers(request as ModelRequest<unknown>) : answers[n];
      const parsed = request.schema.safeParse(answer);
      if (answer === "down" || !parsed.success) {
        return { ok: false, error: "HTTP 503", raw: "", usage: NO_USAGE, ms: 900, requests: 4 };
      }
      const ms = name === "Spark Open" ? 4000 : 9000;
      return { ok: true, output: parsed.data, raw: "", usage: USAGE, ms, requests: 1 };
    },
  };
  const model = name === "Spark Open" ? SPARK_OPEN_MODEL : SPARK_13_MODEL;
  const judge: Judge = { name, model, port, effort: "low" };
  return { judge, requests };
}

const lane = (side: "pr" | "base", status = "completed") =>
  LaneResult.parse({
    criterionId: "C2",
    side,
    status,
    laneStartMs: T0,
    tTriggerMs: status === "completed" ? TT : null,
    stepLog: [
      {
        tMs: TT,
        step: { op: "click", target: { by: "role", role: "button", name: "Apply" } },
        ok: status === "completed",
        trigger: true,
      },
    ],
    readings: [
      {
        i: 1,
        label: "order total",
        kind: "text",
        phase: "post",
        tMs: TT + 1000,
        value: "$50.00",
        bbox: null,
      },
    ],
    consoleErrorCount: 0,
    failedRequestCount: 0,
    isolation: "ephemeral_user",
    ...(status !== "completed" && { failedStepIndex: 0 }),
  });
const take = (side: "pr" | "base", status?: string) => ({
  lane: lane(side, status),
  judgeVideo: "judge.mp4",
  humanVideo: "human.mp4",
  annotatedShot: "shot-annotated.png",
  offsets: { human: 0, judge: 0 },
});

let dir: string;
let item: BenchItem;
let stills: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "intentbench-judging-"));
  for (const folder of ["pr-1", "pr-2", "base"]) {
    const at = join(packDir(dir, benchCase.id, "C2"), folder);
    mkdirSync(at, { recursive: true });
    for (const f of ["judge.mp4", "shot-annotated.png"]) writeFileSync(join(at, f), f);
  }
  stills = ["1.jpg", "2.jpg"].map((f) => join(dir, f));
  for (const s of stills) writeFileSync(s, s);
  item = {
    case: benchCase,
    criterion: C2,
    ticket,
    // Like the real discount packs: the base has no discount field, so its trigger is absent.
    pack: Pack.parse({
      caseId: benchCase.id,
      criterionId: "C2",
      recordedAt: "2026-11-01T12:00:00.000Z",
      origin: "https://pr.preview.test",
      baseOrigin: "https://base.preview.test",
      explore: { status: "found", reason: null, modelCalls: 2, ms: 9000, costUsd: 0.015 },
      path: {
        criterionId: "C2",
        setup: [{ op: "goto", path: "/cart" }],
        trigger: [{ op: "click", target: { by: "role", role: "button", name: "Apply" } }],
        watch: [{ label: "summary", scope: "region", target: { by: "testId", id: "summary" } }],
        portable: true,
      },
      takes: { pr: [take("pr"), take("pr")], base: take("base", "trigger_absent") },
    }),
    diff: {
      base: "b".repeat(40),
      head: "h".repeat(40),
      files: [
        {
          path: "components/CartView.tsx",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch:
            "-  const total = subtotal - discount;\n+  const total = useMemo(() => subtotal, [lines]);",
        },
      ],
    },
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const optionsWith = (...judges: { judge: Judge }[]) => ({
  dir,
  stillsDir: join(dir, "stills"),
  judges: Object.fromEntries(judges.map(({ judge }) => [judge.name, judge])),
  stills: () => stills,
});
const byView = (j: Judging) => Object.fromEntries(j.verdicts.map((v) => [v.view, v]));
const pick = (v: BenchVerdict) => [v.verdict, v.reason, v.take, v.calls];
const userParts = (r: ModelRequest<unknown>) => r.messages[1]!.content as ContentPart[];

describe("arm D: both judges, each also alone (§31), with §19 e on the two takes", () => {
  it("an agreed pass stands on the first take: two calls, three verdicts", async () => {
    const [so, s13] = [judgeWith("Spark Open", [pass]), judgeWith("Spark 1.3", [pass])];
    const judging = await judgeItem("D", 1, item, optionsWith(so, s13));
    const views = byView(judging);
    expect(pick(views.dual!)).toEqual(["pass", "agreed", "pr-1", 2]);
    expect(pick(views["Spark Open"]!)).toEqual(["pass", "decided", "pr-1", 1]);
    expect(pick(views["Spark 1.3"]!)).toEqual(["pass", "decided", "pr-1", 1]);
    // The two calls run at once: the slower judge's 9 s is the dual verdict's time.
    expect(views.dual).toMatchObject({ usd: 2 * PER_CALL, ms: 9000 });
    expect(views["Spark Open"]).toMatchObject({ usd: PER_CALL, ms: 4000 });
    expect(judging.calls.map((c) => `${c.judge} ${c.take}`)).toEqual([
      "Spark Open pr-1",
      "Spark 1.3 pr-1",
    ]);
    // Exactly the worker's bundle: the annotated still and the PR video; no base video, since
    // the base's trigger was absent.
    const kinds = userParts(so.requests[0]!).map((p) => p.type);
    expect(kinds).toEqual(["text", "text", "image_url", "text", "video_url"]);
  });

  it("an agreed fail is judged again on the second take, and stands when it repeats", async () => {
    const so = judgeWith("Spark Open", [fail, fail]);
    const s13 = judgeWith("Spark 1.3", [fail, fail]);
    const views = byView(await judgeItem("D", 1, item, optionsWith(so, s13)));
    expect(pick(views.dual!)).toEqual(["fail", "agreed", "pr-2", 4]);
    expect(pick(views["Spark 1.3"]!)).toEqual(["fail", "decided", "pr-2", 2]);
    expect(views.dual!.ms).toBe(18_000);
  });

  it("a fail that doesn't repeat on the second take is flaky", async () => {
    const so = judgeWith("Spark Open", [fail, pass]);
    const s13 = judgeWith("Spark 1.3", [fail, pass]);
    const views = byView(await judgeItem("D", 1, item, optionsWith(so, s13)));
    expect(pick(views.dual!)).toEqual(["inconclusive", "flaky", "pr-2", 4]);
    expect(pick(views["Spark Open"]!)).toEqual(["inconclusive", "flaky", "pr-2", 2]);
  });

  it("a tie is settled on the second take; each judge alone keeps its own first answer", async () => {
    const so = judgeWith("Spark Open", [pass, fail]);
    const s13 = judgeWith("Spark 1.3", [fail, fail]);
    const views = byView(await judgeItem("D", 1, item, optionsWith(so, s13)));
    // An agreed fail on pr-2, a verdict one judge gave first: it stands (§19 e).
    expect(pick(views.dual!)).toEqual(["fail", "agreed", "pr-2", 4]);
    // Spark Open alone passed on pr-1, and a pass isn't re-recorded.
    expect(pick(views["Spark Open"]!)).toEqual(["pass", "decided", "pr-1", 1]);
    expect(pick(views["Spark 1.3"]!)).toEqual(["fail", "decided", "pr-2", 2]);
  });

  it("asks again only the judge whose own fail needs confirming", async () => {
    const so = judgeWith("Spark Open", [fail, fail]);
    const s13 = judgeWith("Spark 1.3", [miscited]);
    const judging = await judgeItem("D", 1, item, optionsWith(so, s13));
    const views = byView(judging);
    // One checked fail and one contradicted answer: inconclusive, which §19 e doesn't re-record.
    expect(pick(views.dual!)).toEqual(["inconclusive", "contradicts_readings", "pr-1", 2]);
    expect(pick(views["Spark Open"]!)).toEqual(["fail", "decided", "pr-2", 2]);
    expect(pick(views["Spark 1.3"]!)).toEqual(["inconclusive", "contradicts_readings", "pr-1", 1]);
    expect([so.requests.length, s13.requests.length]).toEqual([2, 1]);
    expect(judging.calls.find((c) => c.judge === "Spark 1.3")).toMatchObject({
      verdict: "fail",
      checked: "inconclusive",
      checkedReason: "contradicts_readings",
      citedValue: "$45.00",
    });
  });
});

describe("arms A, B and C: Spark 1.3 alone", () => {
  it("A reviews the diff with review.v1: no media, no browser data", async () => {
    const s13 = judgeWith("Spark 1.3", [
      { verdict: "fail", citedFile: "components/CartView.tsx", citedCode: "useMemo", observed: "" },
    ]);
    const judging = await judgeItem("A", 1, item, optionsWith(s13));
    expect(pick(judging.verdicts[0]!)).toEqual(["fail", "decided", "diff", 1]);
    expect(judging.calls[0]).toMatchObject({ take: "diff", citedFile: "components/CartView.tsx" });
    const request = s13.requests[0]!;
    expect(request).toMatchObject({ stage: "review", promptVersion: "review.v1" });
    expect(typeof request.messages[1]!.content).toBe("string");
    expect(request.messages[1]!.content).toContain("useMemo(() => subtotal");
  });

  it("B sends text alone; C the annotated still and the stills, never a video", async () => {
    const b = judgeWith("Spark 1.3", [pass]);
    await judgeItem("B", 1, item, optionsWith(b));
    expect(userParts(b.requests[0]!).every((p) => p.type === "text")).toBe(true);

    const c = judgeWith("Spark 1.3", [pass]);
    await judgeItem("C", 1, item, optionsWith(c));
    const kinds = userParts(c.requests[0]!).map((p) => p.type);
    expect(kinds).toEqual(["text", "text", "image_url", "text", "image_url", "image_url"]);
  });

  it("a judge that gives no answer makes it inconclusive (infra_error), and the call says why", async () => {
    const judging = await judgeItem("B", 1, item, optionsWith(judgeWith("Spark 1.3", ["down"])));
    expect(pick(judging.verdicts[0]!)).toEqual(["inconclusive", "infra_error", "pr-1", 1]);
    expect(judging.calls[0]).toMatchObject({ ok: false, error: "HTTP 503", verdict: null });
  });
});

describe("a pack whose exploration failed", () => {
  it("is inconclusive (setup_failed) with no calls for B–D, while A still reviews the diff", async () => {
    item.pack = Pack.parse({
      ...item.pack,
      explore: { ...item.pack.explore, status: "setup_failed", reason: "the cart throws" },
      path: null,
      takes: null,
    });
    const so = judgeWith("Spark Open", []);
    const s13 = judgeWith("Spark 1.3", [review]);
    const d = await judgeItem("D", 1, item, optionsWith(so, s13));
    expect(d.calls).toEqual([]);
    expect(d.verdicts.map(pick)).toEqual([
      ["inconclusive", "setup_failed", null, 0],
      ["inconclusive", "setup_failed", null, 0],
      ["inconclusive", "setup_failed", null, 0],
    ]);
    const a = await judgeItem("A", 1, item, optionsWith(s13));
    expect(pick(a.verdicts[0]!)).toEqual(["pass", "decided", "diff", 1]);
  });
});

describe("judgeAll", () => {
  const run = (judges: { judge: Judge }[], over: Record<string, unknown> = {}) => {
    const kept: Judging[] = [];
    const lines: string[] = [];
    const summary = judgeAll([item], {
      ...optionsWith(...judges),
      arms: ["A", "B"],
      repeats: 2,
      log: (line) => lines.push(line),
      onJudged: (j) => kept.push(j),
      concurrency: 1,
      ...over,
    });
    return { summary, kept, lines };
  };

  it("judges each arm in each repeat, skipping what an earlier run judged", async () => {
    const s13 = judgeWith("Spark 1.3", passing);
    const done = new Set([itemKey({ arm: "A", repeat: 1, case: benchCase.id, criterion: "C2" })]);
    const { summary, kept, lines } = run([s13], { done });
    expect(await summary).toMatchObject({ judged: 3, crashed: [], stopped: null, left: 0 });
    expect(kept.map((j) => itemKey(j.verdicts[0]!))).toEqual([
      "B 1 discount-almost-right C2",
      "A 2 discount-almost-right C2",
      "B 2 discount-almost-right C2",
    ]);
    expect(lines[0]).toBe("1 judged before, 3 to judge");
    expect(lines[1]).toBe(
      "B 1 discount-almost-right C2 [fail]: Spark 1.3 pass · 1 calls, $0.0017, 9.0 s",
    );
  });

  it("starts nothing more once the calls reach the cost cap", async () => {
    const s13 = judgeWith("Spark 1.3", passing);
    const { summary } = run([s13], { maxUsd: 1.5 * PER_CALL });
    expect(await summary).toMatchObject({ judged: 2, left: 2 });
    expect((await summary).stopped).toMatch(/--max-usd cap/);
  });

  it("leaves no verdict for a criterion that crashed, so a rerun judges it", async () => {
    // Arm B needs Spark 1.3, which this run has no key for.
    const { summary, kept } = run([], { arms: ["B"], repeats: 1 });
    expect(await summary).toMatchObject({ judged: 0, crashed: ["B 1 discount-almost-right C2"] });
    expect(kept).toEqual([]);
  });
});

describe("the results file", () => {
  const packs = { "discount-almost-right/C2": "a".repeat(64) };
  const results = async () => {
    const so = judgeWith("Spark Open", [fail, fail]);
    const s13 = judgeWith("Spark 1.3", [fail, fail]);
    const d = await judgeItem("D", 1, item, optionsWith(so, s13));
    return BenchResults.parse({
      version: 1,
      split: "heldout",
      prompts: { D: "judge.v1" },
      models: { "Spark Open": SPARK_OPEN_MODEL, "Spark 1.3": SPARK_13_MODEL },
      startedAt: "2026-11-01T12:00:00.000Z",
      updatedAt: "2026-11-01T12:30:00.000Z",
      packs,
      verdicts: d.verdicts,
      calls: d.calls,
    });
  };

  it("holds each view's verdict and every call, and reads back as written", async () => {
    const r = await results();
    expect(r.verdicts.map((v) => v.view)).toEqual(["dual", "Spark Open", "Spark 1.3"]);
    expect(r.calls).toHaveLength(4);
    const text = formatResults(r);
    expect(BenchResults.parse(JSON.parse(text))).toEqual(r);
    // A row per line, so a rerun's diff shows the rows it added.
    expect(text.split("\n").filter((l) => l.startsWith('    {"arm"'))).toHaveLength(7);
  });

  it("rejects a verdict twice, a view its arm doesn't have, and a pack without a hash", async () => {
    const r = await results();
    const issues = (over: object) =>
      BenchResults.safeParse({ ...r, ...over }).error?.issues.map((i) => i.message) ?? [];
    expect(issues({ verdicts: [...r.verdicts, r.verdicts[0]] })).toEqual([
      "D 1 discount-almost-right C2 dual is there twice",
    ]);
    expect(issues({ verdicts: [{ ...r.verdicts[0]!, arm: "B" }] })).toEqual([
      "arm B has no dual view",
    ]);
    expect(issues({ packs: {} })).toHaveLength(3);
  });

  it("drops the rows of a pack recorded again since, so it's judged again", async () => {
    const r = await results();
    expect(stillCurrent(r, packs).verdicts).toHaveLength(3);
    const kept = stillCurrent(r, { "discount-almost-right/C2": "b".repeat(64) });
    expect([kept.verdicts.length, kept.calls.length]).toEqual([0, 0]);
  });

  it("writes its rows in a fixed order, whatever call finished first", async () => {
    const r = await results();
    const shuffled = { ...r, verdicts: [...r.verdicts].reverse(), calls: [...r.calls].reverse() };
    expect(formatResults(shuffled)).toBe(formatResults(r));
  });

  it("tallies each arm's views for the run's log", async () => {
    const r = await results();
    const flaky = { ...r.verdicts[1]!, verdict: "inconclusive" as const, reason: "flaky" as const };
    const passed = { ...r.verdicts[2]!, verdict: "pass" as const };
    expect(tally([r.verdicts[0]!, flaky, passed])).toEqual([
      { ...counts("dual", 1, 0, 0, 1), usd: 4 * PER_CALL },
      { ...counts("Spark Open", 0, 0, 1, 0), usd: 2 * PER_CALL },
      { ...counts("Spark 1.3", 0, 1, 0, 0), usd: 2 * PER_CALL },
    ]);
  });
});

/** A tally row of arm D's view on one label-fail criterion. */
const counts = (
  view: string,
  right: number,
  wrong: number,
  inconclusive: number,
  caught: number,
) => ({
  arm: "D",
  view,
  n: 1,
  right,
  wrong,
  inconclusive,
  caught,
  fails: 1,
});
