import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { ContextBundle, IntenzoConfig, LaneResult, WorkerEvent } from "@intenzo/core";
import { type Judge, SPARK_13_MODEL, SPARK_OPEN_MODEL } from "@intenzo/core/judge";
import { metaModelPort, sparkOpenPort } from "@intenzo/core/models";
import { afterEach, describe, expect, it } from "vitest";

import { jobClient } from "./client.ts";
import { preflight } from "./preflight.ts";
import { EXIT, type RunOptions, runJob } from "./run.ts";
import type { Recorder } from "./verify.ts";

// T7.1, the worker's faults: each injected where it really happens, a preview or a model API
// answering badly on a local port, and the job run as Modal runs it (runJob), with the real
// preflight and the real model ports. Each must end in the state ARCHITECTURE documents (§14,
// §19, §22): a failed job that says why, or verdicts that say infra_error, and never a hang.

const JOB = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
const RUN = "ea44d35d-4baa-4f81-ac92-08285fae4058";
const T0 = 1_900_000_000_000;

const servers: Server[] = [];
afterEach(async () => {
  const open = servers.splice(0);
  await Promise.all(open.map((s) => new Promise<void>((done) => s.close(() => done()))));
});

interface Answer {
  status: number;
  body?: unknown;
}

/** A local server that answers each request with `answer`, and keeps what it was asked. */
async function local(answer: (req: IncomingMessage, body: string) => Answer) {
  const seen: { path: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ path: req.url!, body });
    const out = answer(req, body);
    res
      .writeHead(out.status, { "content-type": "application/json" })
      .end(out.body === undefined ? "" : JSON.stringify(out.body));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** The Cloud's worker routes: the events the job sends, and any signed file it fetches. */
async function fakeCloud(files: Record<string, unknown> = {}) {
  const events: WorkerEvent[] = [];
  const cloud = await local((req, body) => {
    const path = new URL(req.url!, "http://cloud").pathname;
    if (req.method === "GET" && path in files) return { status: 200, body: files[path] };
    if (path === "/api/worker/events") {
      events.push(WorkerEvent.parse(JSON.parse(body)));
      return { status: 202, body: { status: "stored" } };
    }
    if (path === "/api/worker/alive") return { status: 200, body: {} };
    return { status: 404 };
  });
  return { ...cloud, events };
}

const previewAnswering = (status: number) => local(() => ({ status, body: { status } }));

/** A completed lane with one reading a judge can cite. */
const laneFor = (criterionId: string, side: "pr" | "base") =>
  LaneResult.parse({
    criterionId,
    side,
    status: "completed",
    laneStartMs: T0,
    tTriggerMs: T0 + 5000,
    stepLog: [
      {
        tMs: T0 + 5000,
        step: { op: "click", target: { by: "role", role: "button", name: "Apply" } },
        ok: true,
        trigger: true,
      },
    ],
    readings: [
      {
        i: 0,
        label: "order total",
        kind: "text",
        phase: "post",
        tMs: T0 + 6000,
        value: "$45.00",
        bbox: null,
      },
    ],
    consoleErrorCount: 0,
    failedRequestCount: 0,
    isolation: "ephemeral_user",
  });

/**
 * Records nothing (each lane completes, with no video), but checks each preview with the real
 * preflight, its retries made short: the fault is in the preview, not here.
 */
function fakeRecorder() {
  const asked: string[] = [];
  const recorder: Recorder = {
    async record(input) {
      asked.push(`${input.criterion.id} ${input.side}`);
      return { lane: laneFor(input.criterion.id, input.side), video: null };
    },
    preflight: ({ origin, bypass }) =>
      preflight(origin, { ...(bypass && { bypass }), retryDelaysMs: [1, 1] }),
    async close() {},
  };
  return { recorder, asked };
}

const job = (cloud: string, over: Record<string, unknown>) => ({
  type: "verify",
  jobId: JOB,
  runId: RUN,
  deadlineAt: "2030-01-01T00:00:00.000Z",
  callback: { baseUrl: cloud, token: "job-token" },
  config: IntenzoConfig.parse({ version: 1, isolation: { session_hook: "/api/test/session" } }),
  bundleUrl: null,
  intent: null,
  baseUrl: null,
  baseSha: null,
  secrets: { hookSecret: "hook-secret-for-the-test-0123456789" },
  cachedPaths: [],
  ...over,
});

const run = (payload: unknown, options: RunOptions) =>
  runJob(payload, {
    client: (j) => jobClient(j, { retryDelayMs: 1 }),
    log: () => {},
    judges: null,
    ...options,
  });

// Both hosts answer OpenAI-style Chat Completions (dev.meta.ai/docs; Baseten's Model APIs).
const completion = (content: unknown) => ({
  choices: [{ message: { content: JSON.stringify(content) } }],
  usage: { prompt_tokens: 1000, completion_tokens: 100 },
});
const passing = {
  verdict: "pass",
  targetCorrect: true,
  citedReadings: [0],
  citedValue: "$45.00",
  atMs: 6000,
  observed: "The total read $45.00.",
};
/** The two judges, as judgesFromEnv() makes them, on a local host; their retries don't wait. */
const judgesAt = (url: string): [Judge, Judge] => {
  const options = { apiKey: "test-key", baseUrl: url, sleep: async () => {} };
  return [
    { name: "Spark Open", model: SPARK_OPEN_MODEL, port: sparkOpenPort(options), effort: "low" },
    { name: "Spark 1.3", model: SPARK_13_MODEL, port: metaModelPort(options), effort: "low" },
  ];
};
const modelOf = (body: string) => (JSON.parse(body) as { model: string }).model;

type Event<K extends WorkerEvent["kind"]> = Extract<WorkerEvent, { kind: K }>;
const verdicts = (events: WorkerEvent[]) =>
  events.filter((e): e is Event<"criterion_verdict"> => e.kind === "criterion_verdict");
const kinds = (events: WorkerEvent[]) => [...new Set(events.map((e) => e.kind))];

describe("a preview that answers 500 (§19 step 1)", () => {
  it("ends the job as preview_unreachable after three tries, before anything is recorded", async () => {
    const [cloud, pr] = [await fakeCloud(), await previewAnswering(500)];
    const fake = fakeRecorder();
    const exit = await run(job(cloud.url, { prUrl: pr.url }), { recorder: () => fake.recorder });

    expect(exit).toBe(EXIT.failed);
    expect(cloud.events.map((e) => e.kind)).toEqual(["started", "intent_ready", "failed"]);
    expect(cloud.events.at(-1)).toMatchObject({
      error: {
        code: "preview_unreachable",
        message: `the preview ${pr.url} didn't answer: HTTP 500`,
      },
    });
    expect(pr.seen.map((r) => r.path)).toEqual(["/", "/", "/"]);
    expect(fake.asked).toEqual([]);
  });

  it("goes on without a baseline when only the base preview answers 500", async () => {
    const [cloud, pr, base] = [
      await fakeCloud(),
      await previewAnswering(200),
      await previewAnswering(500),
    ];
    const fake = fakeRecorder();
    const exit = await run(
      job(cloud.url, { prUrl: pr.url, baseUrl: base.url, baseSha: "b".repeat(40) }),
      { recorder: () => fake.recorder },
    );

    expect(exit).toBe(EXIT.finished);
    expect(new Set(fake.asked.map((a) => a.split(" ")[1]))).toEqual(new Set(["pr"]));
    expect(verdicts(cloud.events).map((v) => v.lanes.length)).toEqual([1, 1, 1, 1]);
    expect(cloud.events.at(-1)).toMatchObject({ kind: "finished" });
  });
});

describe("a model API that answers 429 to everything (§14)", () => {
  it("the judges: every verdict inconclusive (infra_error) after four tries a call; the job finishes", async () => {
    const [cloud, pr] = [await fakeCloud(), await previewAnswering(200)];
    const storm = await local(() => ({ status: 429, body: { error: { message: "slow down" } } }));
    const fake = fakeRecorder();
    const exit = await run(job(cloud.url, { prUrl: pr.url }), {
      recorder: () => fake.recorder,
      judges: judgesAt(storm.url),
    });

    expect(exit).toBe(EXIT.finished);
    expect(
      verdicts(cloud.events).map((v) => `${v.verdict.verdict} ${v.verdict.reasonCode}`),
    ).toEqual(Array(4).fill("inconclusive infra_error"));
    // §19 e re-records only a fail or a tie: 4 criteria × 2 judges × 4 tries, nothing more.
    expect(storm.seen).toHaveLength(32);
    expect(cloud.events.at(-1)).toMatchObject({ kind: "finished", outcome: "inconclusive" });
  });

  it("the ticket: the job waits the outage out, then fails before anything is recorded", async () => {
    const files: Record<string, unknown> = {};
    const cloud = await fakeCloud(files);
    files["/bundle.json"] = ContextBundle.parse({
      pr: {
        number: 7,
        title: "Discount codes",
        body: "Closes #5",
        headSha: "a".repeat(40),
        baseRef: "main",
        isFork: false,
        isBot: false,
      },
      ticket: {
        source: "github_issue",
        ref: "#5",
        title: "Discount codes",
        body: "Apply SAVE10 on the cart: the total drops 10% right away.",
        comments: [],
      },
      images: [],
      media: [],
      diff: { files: [] },
      hints: null,
    });
    const [pr, storm] = [
      await previewAnswering(200),
      await local(() => ({ status: 429, body: { error: { message: "slow down" } } })),
    ];
    const fake = fakeRecorder();
    const exit = await run(
      job(cloud.url, { prUrl: pr.url, bundleUrl: `${cloud.url}/bundle.json?sig=1` }),
      {
        recorder: () => fake.recorder,
        models: metaModelPort({ apiKey: "test-key", baseUrl: storm.url, sleep: async () => {} }),
        retryDelaysMs: [1, 1, 1, 1, 1],
      },
    );

    expect(exit).toBe(EXIT.failed);
    expect(cloud.events.map((e) => e.kind)).toEqual(["started", "failed"]);
    expect(cloud.events.at(-1)).toMatchObject({
      error: { code: "crash", message: expect.stringMatching(/^ticket #\d+ couldn't be read/) },
    });
    // The read and its five retries, each a call of four tries.
    expect(storm.seen).toHaveLength(24);
    expect(fake.asked).toEqual([]);
    expect(pr.seen).toEqual([]);
  });
});

describe("Spark Open cold on Baseten", () => {
  /** Spark 1.3 answers; Spark Open answers 503 to its first `cold` requests. */
  async function hosts(cold: number) {
    let openAsked = 0;
    return local((_req, body) => {
      if (modelOf(body) === SPARK_OPEN_MODEL && ++openAsked <= cold) {
        return { status: 503, body: { error: { message: "model is loading" } } };
      }
      return { status: 200, body: completion(passing) };
    });
  }

  it("a cold start the retries outlast: both judges answer, and agree", async () => {
    const [cloud, pr, models] = [await fakeCloud(), await previewAnswering(200), await hosts(2)];
    const fake = fakeRecorder();
    await run(job(cloud.url, { prUrl: pr.url }), {
      recorder: () => fake.recorder,
      judges: judgesAt(models.url),
    });

    for (const v of verdicts(cloud.events)) {
      expect(v.verdict).toMatchObject({ verdict: "pass", reasonCode: "agreed" });
      expect(v.verdict.judges.map((j) => j.model)).toEqual(["Spark Open", "Spark 1.3"]);
    }
    expect(cloud.events.at(-1)).toMatchObject({ kind: "finished", outcome: "pass" });
  });

  it("a cold start longer than the retries: Spark Open is infra_error alone, Spark 1.3's answer stays", async () => {
    const [cloud, pr, models] = [
      await fakeCloud(),
      await previewAnswering(200),
      await hosts(Number.POSITIVE_INFINITY),
    ];
    const fake = fakeRecorder();
    const exit = await run(job(cloud.url, { prUrl: pr.url }), {
      recorder: () => fake.recorder,
      judges: judgesAt(models.url),
    });

    expect(exit).toBe(EXIT.finished);
    for (const v of verdicts(cloud.events)) {
      expect(v.verdict).toMatchObject({ verdict: "inconclusive", reasonCode: "infra_error" });
      // The report still shows what the judge that answered saw (DECISIONS T4.6a).
      expect(v.verdict.judges).toMatchObject([
        { model: "Spark 1.3", verdict: "pass", observed: "The total read $45.00." },
      ]);
    }
    expect(models.seen.filter((r) => modelOf(r.body) === SPARK_OPEN_MODEL)).toHaveLength(16);
    expect(kinds(cloud.events)).toEqual([
      "started",
      "intent_ready",
      "criterion_verdict",
      "finished",
    ]);
  });
});
