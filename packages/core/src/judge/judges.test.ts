import { describe, expect, it } from "vitest";

import { sparkOpenPort } from "../models/meta.ts";
import { scriptedPort, type ScriptedPort } from "../models/scripted.ts";
import { Criterion, LaneResult, type JudgeOutput } from "../schema/index.ts";
import { judgeBundle } from "./bundle.ts";
import { type Judge, judgeCriterion, judgeRequest, judgesFromEnv, verdictOf } from "./judges.ts";

const T0 = 1_900_000_000_000;
const TT = T0 + 4500;
const C2 = Criterion.parse({
  id: "C2",
  text: "The total drops 10% to $45.00 right away",
  trigger: "apply SAVE10",
  setup: [],
  expected: "The total reads $45.00 within 1 s",
  watch: ["order total"],
  kind: "ui_behavior",
  persistence: true,
  timingMs: 1000,
  inferred: false,
});
const lane = (over: Record<string, unknown> = {}) =>
  LaneResult.parse({
    criterionId: "C2",
    side: "pr",
    status: "completed",
    laneStartMs: T0,
    tTriggerMs: TT,
    stepLog: [
      {
        tMs: TT,
        step: { op: "click", target: { by: "role", role: "button", name: "Apply" } },
        ok: true,
        trigger: true,
      },
    ],
    readings: [
      [1, "post", 0, "$50.00"],
      [2, "post", 1000, "$50.00"],
      [3, "post", 3000, "$50.00"],
      [5, "after_reload", 4600, "$45.00"],
    ].map(([i, phase, at, value]) => ({
      i,
      label: "order total",
      kind: "text",
      phase,
      tMs: TT + (at as number),
      value,
      bbox: null,
    })),
    consoleErrorCount: 0,
    failedRequestCount: 0,
    isolation: "ephemeral_user",
    ...over,
  });

const said = (over: Partial<JudgeOutput> = {}): JudgeOutput => ({
  verdict: "fail",
  targetCorrect: true,
  citedReadings: [2],
  citedValue: "$50.00",
  atMs: 5500,
  observed: "The total stayed $50.00 a second after Apply.",
  ...over,
});
function judges(
  a: unknown[],
  b: unknown[],
): { pair: [Judge, Judge]; ports: [ScriptedPort, ScriptedPort] } {
  const ports: [ScriptedPort, ScriptedPort] = [scriptedPort(a as never), scriptedPort(b as never)];
  return {
    pair: [
      { name: "Spark Open", model: "meta-models/muse-spark-open", port: ports[0], effort: "low" },
      { name: "Spark 1.3", model: "muse-spark-1.3", port: ports[1], effort: "low" },
    ],
    ports,
  };
}

describe("judgeCriterion (§22)", () => {
  it("asks both judges the same thing, and agrees on a cited fail", async () => {
    const { pair, ports } = judges([said()], [said({ observed: "It read $50.00." })]);
    const judged = await judgeCriterion(pair, C2, { lane: lane() });
    expect(judged.combined).toEqual({ verdict: "fail", reason: "agreed" });
    expect(ports[0].requests[0]!.messages).toEqual(ports[1].requests[0]!.messages);
    expect(ports[0].requests[0]).toMatchObject({
      stage: "judge",
      promptVersion: "judge.v1",
      reasoningEffort: "low",
    });
    expect(judged.calls.map((c) => `${c.judge} ${c.ok}`)).toEqual([
      "Spark Open true",
      "Spark 1.3 true",
    ]);
    // What IntentBench sends (T6.3) is exactly what the worker sends.
    const parts = judgeBundle(C2, { lane: lane() }).parts;
    expect(ports[0].requests[0]).toEqual(judgeRequest(pair[0], parts));
    expect(ports[1].requests[0]).toEqual(judgeRequest(pair[1], parts));

    const verdict = verdictOf(C2, judged, pair, TT);
    expect(verdict).toMatchObject({
      criterionId: "C2",
      verdict: "fail",
      reasonCode: "agreed",
      evidenceWindow: { startMs: TT - 1000, endMs: TT + 3000 },
      observed: "The total stayed $50.00 a second after Apply.",
    });
    expect(verdict.judges.map((j) => j.model)).toEqual(["Spark Open", "Spark 1.3"]);
  });

  it.each([
    [
      "the judges disagree",
      [said({ verdict: "pass", citedReadings: [5], citedValue: "$45.00" })],
      [said()],
      "judges_disagree",
    ],
    [
      "one cites a value its reading doesn't have",
      [said({ citedValue: "$5.00" })],
      [said()],
      "contradicts_readings",
    ],
    ["one boxes the wrong element", [said({ targetCorrect: false })], [said()], "wrong_target"],
    ["one gives no answer", [{ verdict: "maybe" }], [said()], "infra_error"],
  ])("is inconclusive when %s", async (_case, a, b, reason) => {
    const { pair } = judges(a, b);
    expect((await judgeCriterion(pair, C2, { lane: lane() })).combined).toEqual({
      verdict: "inconclusive",
      reason,
    });
  });

  it("asks no judge when §22.1 decides", async () => {
    const { pair, ports } = judges([], []);
    const judged = await judgeCriterion(pair, C2, {
      lane: lane({ status: "setup_failed", tTriggerMs: null, stepLog: [] }),
    });
    expect(judged.combined).toEqual({ verdict: "inconclusive", reason: "setup_failed" });
    expect(ports[0].requests.length + ports[1].requests.length).toBe(0);
    expect(verdictOf(C2, judged, pair, null)).toMatchObject({
      observed: "Not judged: setup failed.",
      judges: [],
    });
  });

  it("never lets a lane whose trigger was missing pass", async () => {
    const pass = said({ verdict: "pass", citedReadings: [5], citedValue: "$45.00" });
    const { pair } = judges([pass], [pass]);
    const absent = lane({ status: "trigger_absent", tTriggerMs: null, stepLog: [] });
    expect((await judgeCriterion(pair, C2, { lane: absent }, null, "covered")).combined).toEqual({
      verdict: "inconclusive",
      reason: "precondition_unmet",
    });
  });
});

describe("judgesFromEnv", () => {
  it("needs both keys", () => {
    expect(judgesFromEnv({ META_API_KEY: "m" })).toBeNull();
    expect(judgesFromEnv({ BASETEN_API_KEY: "b" })).toBeNull();
    const pair = judgesFromEnv({
      META_API_KEY: "m",
      BASETEN_API_KEY: "b",
      SPARK_OPEN_MODEL: "baseten/open",
    });
    expect(pair?.map((j) => `${j.name} ${j.model} ${j.effort}`)).toEqual([
      "Spark Open baseten/open low",
      "Spark 1.3 muse-spark-1.3 low",
    ]);
  });
});

describe("sparkOpenPort (Baseten's dialect)", () => {
  it("sends max_tokens and no response_format, and still checks the reply", async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(init.body as string) });
      const content = "Here you go:\n```json\n" + JSON.stringify(said()) + "\n```";
      return Response.json({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    }) as unknown as typeof globalThis.fetch;
    const port = sparkOpenPort({ apiKey: "b", fetch });
    const { pair } = judges([], []);
    const result = await judgeCriterion(
      [
        { ...pair[0], port },
        { ...pair[1], port },
      ],
      C2,
      { lane: lane() },
    );
    expect(result.combined.verdict).toBe("fail");
    expect(sent[0]!.url).toBe("https://inference.baseten.co/v1/chat/completions");
    expect(sent[0]!.body).toMatchObject({ max_tokens: 8192, reasoning_effort: "low" });
    expect(sent[0]!.body).not.toHaveProperty("response_format");
    expect(sent[0]!.body).not.toHaveProperty("max_completion_tokens");
  });
});
