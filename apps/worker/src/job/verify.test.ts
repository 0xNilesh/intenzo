import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextBundle, IntenzoConfig, LaneResult, VerifyJob, WorkerEvent } from "@intenzo/core";
import { snapshotLines, subtrees } from "@intenzo/core/changes";
import { combinedHash, prCriteriaTicket, ticketHash } from "@intenzo/core/intent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Judge } from "@intenzo/core/judge";
import { type ModelPort, NO_USAGE, scriptedPort } from "@intenzo/core/models";

import { jobClient, StaleJobError } from "./client.ts";
import { EXIT, runJob } from "./run.ts";
import { type LaneInput, type Recorder, verify } from "./verify.ts";

const JOB = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
const RUN = "ea44d35d-4baa-4f81-ac92-08285fae4058";
const T0 = 1_900_000_000_000;
const PR = "https://demo-shop-git-intenzo-check-sumithprabhus-projects.vercel.app";
const BASE = "https://demo-shop-git-main-sumithprabhus-projects.vercel.app";
const HOOK = "hook-secret-for-the-test-0123456789";
const BYPASS = "bypass-for-the-test-abcdefghijklmnop";

let server: Server | undefined;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "intenzo-verify-test-"));
});
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

/**
 * The Cloud's worker routes and Blob's presigned PUTs on one local port. Blob refuses a path that
 * already holds a file, as it does for URLs presigned without allowOverwrite (T2.6).
 */
async function fakeCloud({
  existing = [] as string[],
  gone = false,
  files = {} as Record<string, string>,
} = {}) {
  const events: WorkerEvent[] = [];
  const stored = new Set(existing);
  const puts: { path: string; type: string | undefined; bytes: number }[] = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const { pathname } = new URL(req.url!, "http://cloud");
    // Signed GET URLs the Cloud hands out: the context bundle (§8).
    if (req.method === "GET" && pathname in files) {
      return void res.writeHead(200, { "content-type": "application/json" }).end(files[pathname]);
    }
    const reply = (status: number, value: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (pathname === "/api/worker/events") {
      events.push(WorkerEvent.parse(JSON.parse(body.toString())));
      return reply(202, { status: "stored" });
    }
    if (pathname === "/api/worker/alive") return reply(gone ? 410 : 200, {});
    if (pathname === "/api/worker/upload-tokens") {
      const { files } = JSON.parse(body.toString()) as { files: { path: string }[] };
      return reply(200, {
        uploads: files.map((f) => ({
          ...f,
          uploadUrl: `${base}/blob/${f.path}`,
          validUntil: "2026-10-31T10:00:00.000Z",
        })),
      });
    }
    const path = pathname.replace(/^\/blob\//, "");
    if (stored.has(path)) return reply(400, { error: { message: "This blob already exists" } });
    stored.add(path);
    puts.push({ path, type: req.headers["content-type"], bytes: body.length });
    return reply(200, {});
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return { base, events, puts };
}

/** A lane as the recorder leaves it: the PR side completes at Tt = T0 + 5 s, the base side lacks the trigger. */
function laneFor(
  criterionId: string,
  side: "pr" | "base",
  status: LaneResult["status"],
): LaneResult {
  const triggered = status === "completed";
  return LaneResult.parse({
    criterionId,
    side,
    status,
    laneStartMs: T0,
    tTriggerMs: triggered ? T0 + 5000 : null,
    stepLog: triggered
      ? [
          {
            tMs: T0 + 5000,
            step: { op: "fill", target: { by: "label", text: "Discount code" }, value: "SAVE10" },
            ok: true,
            trigger: true,
          },
        ]
      : [],
    readings: [],
    consoleErrorCount: 0,
    failedRequestCount: 0,
    isolation: "ephemeral_user",
  });
}

/** Records nothing: answers each lane from `statuses` (or throws), with a few bytes as its video. */
function fakeRecorder(statuses: Record<string, LaneResult["status"] | "throws"> = {}) {
  const asked: LaneInput[] = [];
  let closed = 0;
  const recorder = (): Recorder => ({
    async record(input) {
      asked.push(input);
      const key = `${input.criterion.id} ${input.side}`;
      const status = statuses[key] ?? (input.side === "pr" ? "completed" : "trigger_absent");
      if (status === "throws") throw new Error("browser crashed");
      const humanFile = join(dir, `${input.criterion.id}-${input.side}.mp4`);
      writeFileSync(humanFile, `video of ${key}`);
      return {
        lane: laneFor(input.criterion.id, input.side, status),
        video: { humanFile, offsets: { human: 500 - T0, judge: -T0 } },
      };
    },
    async close() {
      closed += 1;
    },
  });
  return { recorder, asked, closed: () => closed };
}

const verifyJob = (baseUrl: string, over: Record<string, unknown> = {}) => ({
  type: "verify",
  jobId: JOB,
  runId: RUN,
  deadlineAt: "2026-10-31T09:15:00.000Z",
  callback: { baseUrl, token: "job-token" },
  config: IntenzoConfig.parse({
    version: 1,
    isolation: { session_hook: "/api/test/session" },
  }),
  bundleUrl: null,
  intent: null,
  prUrl: PR,
  baseUrl: BASE,
  baseSha: "b6b60c7dde0123456789abcdef0123456789abcd",
  secrets: { hookSecret: HOOK, bypass: BYPASS },
  cachedPaths: [],
  ...over,
});

const run = (job: unknown, recorder: () => Recorder) =>
  runJob(job, {
    client: (j) => jobClient(j, { retryDelayMs: 1 }),
    recorder,
    log: () => {},
    judges: null, // stub verdicts: no model is ever called from a unit test
  });

type Verdicts = Extract<WorkerEvent, { kind: "criterion_verdict" }>[];
/** The verdict events by criterion: criteria run two at a time, so they arrive in any order. */
const verdictsOf = (events: WorkerEvent[]) =>
  (events.filter((e) => e.kind === "criterion_verdict") as Verdicts).sort((a, b) =>
    a.verdict.criterionId.localeCompare(b.verdict.criterionId),
  );

describe("the verify job (stub verdicts on real recordings, T2.7b)", () => {
  it("records each criterion on both previews, uploads the videos and cites them", async () => {
    const cloud = await fakeCloud();
    const fake = fakeRecorder();
    expect(await run(verifyJob(cloud.base), fake.recorder)).toBe(EXIT.finished);

    expect(cloud.events.map((e) => e.kind)).toEqual([
      "started",
      "intent_ready",
      ...Array(4).fill("criterion_verdict"),
      "finished",
    ]);
    // Every lane goes through the session hook and gets the bypass (§21.1, §21.2).
    expect(fake.asked.map((a) => `${a.criterion.id} ${a.side} ${a.origin}`).sort()).toEqual(
      ["C1", "C2", "C3", "C4"].flatMap((id) => [`${id} pr ${PR}`, `${id} base ${BASE}`]).sort(),
    );
    for (const input of fake.asked) {
      expect(input).toMatchObject({
        identity: { hookPath: "/api/test/session", secret: HOOK },
        bypass: BYPASS,
        path: { criterionId: input.criterion.id },
      });
    }

    const verdicts = verdictsOf(cloud.events);
    expect(verdicts.map((v) => `${v.verdict.criterionId}:${v.verdict.verdict}`)).toEqual([
      "C1:pass",
      "C2:fail",
      "C3:pass",
      "C4:pass",
    ]);
    // §22: the window is [Tt − 1 s, Tt + 3 s] of the PR recording.
    expect(verdicts[1]!.verdict.evidenceWindow).toEqual({ startMs: T0 + 4000, endMs: T0 + 8000 });
    expect(verdicts[1]!.lanes).toMatchObject([
      {
        side: "pr",
        status: "completed",
        humanVideo: {
          store: "private",
          path: `runs/${RUN}/C2/pr/take-1/human.mp4`,
          contentType: "video/mp4",
          bytes: "video of C2 pr".length,
        },
        videoOffsets: { human: 500 - T0, judge: -T0 },
      },
      {
        side: "base",
        status: "trigger_absent",
        humanVideo: { path: `runs/${RUN}/C2/base/take-1/human.mp4` },
      },
    ]);
    expect(cloud.puts).toHaveLength(8);
    expect(new Set(cloud.puts.map((p) => p.type))).toEqual(new Set(["video/mp4"]));
    expect(cloud.events.at(-1)).toMatchObject({ kind: "finished", outcome: "fail", costUsd: 0 });
    expect(fake.closed()).toBe(1);
  });

  it("gives a fork's lanes no identity and no bypass (§29)", async () => {
    const cloud = await fakeCloud();
    const fake = fakeRecorder();
    await run(verifyJob(cloud.base, { secrets: null }), fake.recorder);
    expect(fake.asked).toHaveLength(8);
    for (const input of fake.asked) {
      expect(input.identity).toBeUndefined();
      expect(input.bypass).toBeUndefined();
    }
  });

  it("records only the PR side when the run has no baseline", async () => {
    const cloud = await fakeCloud();
    const fake = fakeRecorder();
    await run(verifyJob(cloud.base, { baseUrl: null, baseSha: null }), fake.recorder);
    expect(new Set(fake.asked.map((a) => a.side))).toEqual(new Set(["pr"]));
    expect(verdictsOf(cloud.events).map((v) => v.lanes.length)).toEqual([1, 1, 1, 1]);
  });

  it("re-runs only the criteria it's asked for", async () => {
    const cloud = await fakeCloud();
    const fake = fakeRecorder();
    await run(verifyJob(cloud.base, { only: ["C2"] }), fake.recorder);
    expect(verdictsOf(cloud.events).map((v) => v.verdict.criterionId)).toEqual(["C2"]);
  });

  it("uploads into the next take when an earlier job of the run left one (§28)", async () => {
    const cloud = await fakeCloud({ existing: [`runs/${RUN}/C1/pr/take-1/human.mp4`] });
    await run(verifyJob(cloud.base), fakeRecorder().recorder);
    expect(verdictsOf(cloud.events)[0]!.lanes[0]!.humanVideo?.path).toBe(
      `runs/${RUN}/C1/pr/take-2/human.mp4`,
    );
  });

  it("says inconclusive, with §22.1's reason, when the PR side doesn't complete", async () => {
    const cloud = await fakeCloud();
    const fake = fakeRecorder({
      "C1 pr": "setup_failed",
      "C2 pr": "throws",
      "C3 pr": "trigger_absent",
      "C4 pr": "error",
    });
    expect(await run(verifyJob(cloud.base), fake.recorder)).toBe(EXIT.finished);
    const verdicts = verdictsOf(cloud.events).map((v) => v.verdict);
    expect(verdicts.map((v) => `${v.criterionId}:${v.verdict}:${v.reasonCode}`)).toEqual([
      "C1:inconclusive:setup_failed",
      "C2:inconclusive:infra_error",
      "C3:inconclusive:precondition_unmet",
      "C4:inconclusive:infra_error",
    ]);
    expect(verdicts.every((v) => v.evidenceWindow === null)).toBe(true);
    expect(verdicts[1]!.observed).toBe("Not judged: the PR side wasn't recorded.");
    expect(verdicts[0]!.observed).toBe('Not judged: the PR recording ended "setup_failed".');
    expect(cloud.events.at(-1)).toMatchObject({ kind: "finished", outcome: "inconclusive" });
  });

  it("stops at once, and closes the browser, when the run has moved on", async () => {
    const cloud = await fakeCloud({ gone: true });
    const fake = fakeRecorder();
    expect(await run(verifyJob(cloud.base), fake.recorder)).toBe(EXIT.stale);
    expect(cloud.events.map((e) => e.kind)).toEqual(["started", "intent_ready"]);
    expect(fake.asked).toEqual([]);
    expect(fake.closed()).toBe(1);
  });
});

// T4.6b: the judges in the job. Each fake PR take reads "VALUE n" (n = the take), so a judge can
// cite it; the judges' answers come from `answer`, by criterion and take.
describe("the verify job with judges (T4.6b)", () => {
  function judgingRecorder(delayMs = 0) {
    const takes = new Map<string, number>();
    let inFlight = 0;
    let most = 0;
    const recorded: string[] = [];
    const recorder = (): Recorder => ({
      async record(input) {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        inFlight--;
        const key = `${input.criterion.id} ${input.side}`;
        const take = (takes.get(key) ?? 0) + 1;
        takes.set(key, take);
        recorded.push(`${key} take ${take}`);
        const lane = laneFor(
          input.criterion.id,
          input.side,
          input.side === "pr" ? "completed" : "trigger_absent",
        );
        if (input.side === "pr") {
          lane.readings = [
            {
              i: 0,
              label: input.criterion.watch[0] ?? "x",
              kind: "text",
              phase: "post",
              tMs: T0 + 6000,
              value: `VALUE ${take}`,
              bbox: null,
            },
          ];
        }
        const humanFile = join(dir, `${input.criterion.id}-${input.side}-${take}.mp4`);
        writeFileSync(humanFile, `video of ${key} ${take}`);
        return {
          lane,
          video: { humanFile, offsets: { human: 500 - T0, judge: -T0 } },
          judge: { video: humanFile },
          boxTrack: [
            {
              tMs: T0 + 5500,
              label: "order total",
              box: [880, 410, 96, 24] as [number, number, number, number],
            },
          ],
        };
      },
      async evidence(input) {
        evidence.push(input);
        const gif = join(dir, `evidence-${evidence.length}.gif`);
        const still = join(dir, `evidence-${evidence.length}.png`);
        writeFileSync(gif, "GIF89a");
        writeFileSync(still, "png");
        // A segmenter isn't called here (it would reach SAM): its render says what SAM cost.
        return {
          gif,
          still,
          fps: 8,
          width: 640,
          bytes: 6,
          outlined: 30,
          frames: 40,
          ...(input.segment && {
            segmentation: { outcome: "ok", costUsd: 0.01, detail: "(944, 348)", masked: 39 },
          }),
        };
      },
      async close() {},
    });
    const evidence: Parameters<NonNullable<Recorder["evidence"]>>[0][] = [];
    return { recorder, recorded, most: () => most, evidence };
  }

  type Answer = "pass" | "fail" | "inconclusive";
  /** Two scripted judges; `answer(criterionId, take)` gives both judges' verdicts. */
  function scriptedJudges(answer: (id: string, take: number) => [Answer, Answer], delayMs = 0) {
    let inFlight = 0;
    let most = 0;
    const judge = (n: 0 | 1): Judge => ({
      name: n === 0 ? "Spark Open" : "Spark 1.3",
      model: n === 0 ? "meta-models/muse-spark-open" : "muse-spark-1.3",
      effort: "low",
      port: scriptedPort(async (request) => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        inFlight--;
        const text = (request.messages[1]!.content as { type: string; text?: string }[])[0]!.text!;
        const id = /^CRITERION (C\d+)/.exec(text)![1]!;
        const take = Number(/VALUE (\d+)/.exec(text)![1]);
        const verdict = answer(id, take)[n];
        return {
          verdict,
          targetCorrect: true,
          citedReadings: verdict === "inconclusive" ? [] : [0],
          citedValue: verdict === "inconclusive" ? null : `VALUE ${take}`,
          // A decisive moment far from Tt: the evidence window must not follow it (§22.3).
          atMs: verdict === "inconclusive" ? null : 60_000,
          observed: `${id} take ${take}: ${verdict}`,
        };
      }),
    });
    return { pair: [judge(0), judge(1)] as [Judge, Judge], most: () => most };
  }

  const runJudged = (job: unknown, recorder: () => Recorder, judges: [Judge, Judge]) =>
    runJob(job, {
      client: (j) => jobClient(j, { retryDelayMs: 1 }),
      recorder,
      log: () => {},
      judges,
    });

  it("reports the judges' verdicts, by name, in place of the stub's", async () => {
    const cloud = await fakeCloud();
    const judges = scriptedJudges((id) => (id === "C2" ? ["fail", "fail"] : ["pass", "pass"]));
    expect(await runJudged(verifyJob(cloud.base), judgingRecorder().recorder, judges.pair)).toBe(
      EXIT.finished,
    );
    const verdicts = verdictsOf(cloud.events).map((v) => v.verdict);
    expect(verdicts.map((v) => `${v.criterionId}:${v.verdict}:${v.reasonCode}`)).toEqual([
      "C1:pass:agreed",
      "C2:fail:agreed",
      "C3:pass:agreed",
      "C4:pass:agreed",
    ]);
    expect(verdicts[0]!.judges.map((j) => j.model)).toEqual(["Spark Open", "Spark 1.3"]);
    expect(verdicts[0]!.observed).toBe("C1 take 1: pass");
    expect(cloud.events.at(-1)).toMatchObject({ kind: "finished", outcome: "fail" });
  });

  it("sends each judged criterion's GIF and still, in the public store, cut from Tt's window, not the judges' atMs (§23)", async () => {
    const cloud = await fakeCloud();
    const fake = judgingRecorder();
    const judges = scriptedJudges((id) => (id === "C2" ? ["fail", "fail"] : ["pass", "pass"]));
    await runJudged(verifyJob(cloud.base, { evidenceStore: "public" }), fake.recorder, judges.pair);
    const sent = cloud.events.filter((e) => e.kind === "criterion_evidence") as Extract<
      WorkerEvent,
      { kind: "criterion_evidence" }
    >[];
    expect(sent.map((e) => e.criterionId).sort()).toEqual(["C1", "C2", "C3", "C4"]);
    const c2 = sent.find((e) => e.criterionId === "C2")!;
    // The fail was re-recorded: the GIF comes from the take the verdict rests on.
    expect(c2.gif).toMatchObject({
      store: "public",
      path: `runs/${RUN}/C2/pr/take-2/evidence.gif`,
      contentType: "image/gif",
    });
    expect(c2.still).toMatchObject({ store: "public", contentType: "image/png" });
    const c2Input = fake.evidence.find((e) => e.caption.startsWith("C2"))!;
    expect(c2Input).toMatchObject({
      window: { startMs: T0 + 4000, endMs: T0 + 8000 },
      tTriggerMs: T0 + 5000,
      label: "order total",
      caption: "C2 ❌ C2 take 2: fail",
    });
  });

  it("has SAM highlight a visual criterion when the job can call Meta, and counts its cost (T5.2)", async () => {
    // The worker reads the Meta key from its environment. With no bundle nothing else asks a
    // model, and the fake recorder never calls the segmenter, so nothing reaches the network.
    vi.stubEnv("META_API_KEY", "test-key");
    try {
      const cloud = await fakeCloud();
      const fake = judgingRecorder();
      const judges = scriptedJudges(() => ["pass", "pass"]);
      await runJudged(verifyJob(cloud.base), fake.recorder, judges.pair);
      const segmented = fake.evidence.filter((e) => e.segment).map((e) => e.caption.slice(0, 2));
      expect(segmented).toEqual(["C4"]); // the ui_visual one
      expect(cloud.events.at(-1)).toMatchObject({ kind: "finished" });
      expect((cloud.events.at(-1) as { costUsd: number }).costUsd).toBeCloseTo(0.01, 10);
    } finally {
      vi.unstubAllEnvs();
    }
    // Without the key, no segmenter: the element's box, as in T5.1.
    vi.stubEnv("META_API_KEY", "");
    vi.stubEnv("MODEL_API_KEY", "");
    try {
      const plain = judgingRecorder();
      const judges = scriptedJudges(() => ["pass", "pass"]);
      await runJudged(verifyJob((await fakeCloud()).base), plain.recorder, judges.pair);
      expect(plain.evidence.some((e) => e.segment)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps a private repo's evidence in the private store (§28)", async () => {
    const cloud = await fakeCloud();
    const judges = scriptedJudges((id) => (id === "C2" ? ["fail", "fail"] : ["pass", "pass"]));
    await runJudged(verifyJob(cloud.base), judgingRecorder().recorder, judges.pair);
    const sent = cloud.events.filter((e) => e.kind === "criterion_evidence") as Extract<
      WorkerEvent,
      { kind: "criterion_evidence" }
    >[];
    expect(sent).toHaveLength(4);
    expect(sent.flatMap((e) => [e.gif.store, e.still.store]).every((s) => s === "private")).toBe(
      true,
    );
  });

  it("records a fail once more to confirm it, and cites the new take", async () => {
    const cloud = await fakeCloud();
    const fake = judgingRecorder();
    const judges = scriptedJudges((id) => (id === "C2" ? ["fail", "fail"] : ["pass", "pass"]));
    await runJudged(verifyJob(cloud.base), fake.recorder, judges.pair);
    expect(fake.recorded.filter((r) => r.startsWith("C2 pr"))).toEqual([
      "C2 pr take 1",
      "C2 pr take 2",
    ]);
    expect(fake.recorded.filter((r) => r.startsWith("C1 pr"))).toEqual(["C1 pr take 1"]);
    const c2 = verdictsOf(cloud.events)[1]!;
    expect(c2.verdict).toMatchObject({ verdict: "fail", observed: "C2 take 2: fail" });
    expect(c2.lanes[0]!.humanVideo?.path).toBe(`runs/${RUN}/C2/pr/take-2/human.mp4`);
  });

  it("calls a fail that doesn't repeat flaky", async () => {
    const cloud = await fakeCloud();
    const judges = scriptedJudges((id, take) =>
      id === "C2" && take === 1 ? ["fail", "fail"] : ["pass", "pass"],
    );
    await runJudged(verifyJob(cloud.base), judgingRecorder().recorder, judges.pair);
    expect(verdictsOf(cloud.events)[1]!.verdict).toMatchObject({
      verdict: "inconclusive",
      reasonCode: "flaky",
    });
    expect(cloud.events.at(-1)).toMatchObject({ kind: "finished", outcome: "inconclusive" });
  });

  it("settles a tie with a re-record only on a verdict a first judge gave", async () => {
    const cloud = await fakeCloud();
    const judges = scriptedJudges((id, take) =>
      id !== "C3" ? ["pass", "pass"] : take === 1 ? ["pass", "inconclusive"] : ["fail", "fail"],
    );
    await runJudged(verifyJob(cloud.base), judgingRecorder().recorder, judges.pair);
    expect(verdictsOf(cloud.events)[2]!.verdict).toMatchObject({
      verdict: "inconclusive",
      reasonCode: "judges_disagree",
    });
  });

  it("records two criteria at a time, and judges at most four calls at a time", async () => {
    const cloud = await fakeCloud();
    const fake = judgingRecorder(20);
    const judges = scriptedJudges(() => ["pass", "pass"], 20);
    await runJudged(verifyJob(cloud.base), fake.recorder, judges.pair);
    expect(fake.most()).toBe(2);
    expect(judges.most()).toBeLessThanOrEqual(4);
    expect(judges.most()).toBeGreaterThanOrEqual(2);
  });

  it("stops before judging once the run has moved on", async () => {
    let alive = 0;
    const cloud = await fakeCloud();
    const judges = scriptedJudges(() => ["pass", "pass"]);
    const client = (j: Parameters<typeof jobClient>[0]) => {
      const real = jobClient(j, { retryDelayMs: 1 });
      return {
        ...real,
        async alive() {
          // The first check per criterion passes; the one before judging finds the run over.
          if (++alive > 4) throw new StaleJobError();
        },
      };
    };
    const result = await runJob(verifyJob(cloud.base), {
      client,
      recorder: judgingRecorder().recorder,
      log: () => {},
      judges: judges.pair,
    });
    expect(result).toBe(EXIT.stale);
    expect(verdictsOf(cloud.events)).toEqual([]);
  });
});

// T4.8: the job reads its ticket and recording from the bundle, and maps coverage from its diff.
describe("the verify job with a context bundle (§8, §18)", () => {
  const MEDIA_HASH = "f".repeat(64);
  const TICKET = {
    ref: "#5",
    title: "Discount codes",
    body: "The details are in the screen recording below.",
    comments: [],
  };
  const bundleFor = (base: string) =>
    ContextBundle.parse({
      pr: {
        number: 7,
        title: "Discount codes",
        body: "Closes #5",
        headSha: "a".repeat(40),
        baseRef: "main",
        isFork: false,
        isBot: false,
      },
      ticket: { source: "github_issue", ...TICKET },
      images: [],
      media: [{ store: "private", path: "runs/r/ticket/media-1.mp4", contentType: "video/mp4" }],
      mediaUrls: [`${base}/media.mp4?sig=1`],
      diff: {
        files: [
          {
            path: "lib/cart.ts",
            status: "modified",
            additions: 15,
            deletions: 2,
            patch: "+ priceCart",
          },
        ],
      },
      hints: null,
    });
  const said = (text: string) => ({
    text,
    trigger: "apply SAVE10",
    setup: [],
    expected: `${text}, exactly`,
    watch: ["order total"],
    kind: "ui_behavior",
    persistence: false,
    timingMs: null,
    inferred: false,
    sourceQuote: text,
    sourceMediaAt: 9400,
  });
  /** Spark for intent and coverage, scripted by stage. */
  const models = () =>
    scriptedPort((request) =>
      request.stage === "intent"
        ? {
            criteria: [
              said("The total drops to $45.00 right away"),
              said("SAVE10 adds its own line"),
            ],
            repro: { startPath: "/cart", steps: [] },
          }
        : {
            items: [
              { criterionId: "C1", files: ["lib/cart.ts"], status: "covered" },
              { criterionId: "C2", files: [], status: "uncovered" },
            ],
          },
    );
  const recording = async () => ({
    transcript: {
      text: "When I apply save 10, the total should drop 10% right away.",
      audioDurationMs: 36_500,
      ms: 1,
    },
    dataUrl: "data:video/mp4;base64,AAAA",
    bytes: 4,
    mediaHash: MEDIA_HASH,
  });

  async function runWithBundle(
    over: Record<string, unknown> = {},
    deps: Record<string, unknown> = {},
    bundleOver: Record<string, unknown> = {},
  ) {
    const files: Record<string, string> = {};
    const cloud = await fakeCloud({ files });
    files["/bundle.json"] = JSON.stringify({ ...bundleFor(cloud.base), ...bundleOver });
    const job = VerifyJob.parse({
      ...verifyJob(cloud.base),
      bundleUrl: `${cloud.base}/bundle.json?sig=1`,
      ...over,
    });
    const port = models();
    await verify(job, jobClient(job, { retryDelayMs: 1 }), {
      recorder: fakeRecorder().recorder(),
      log: () => {},
      judges: null,
      models: port,
      readRecording: recording,
      ...deps,
    });
    const ready = cloud.events.find((e) => e.kind === "intent_ready") as Extract<
      WorkerEvent,
      { kind: "intent_ready" }
    >;
    return { ready, port, events: cloud.events };
  }

  it("reads the ticket and the PM's recording into the criteria, and maps them to the diff", async () => {
    const { ready, port } = await runWithBundle();
    expect(ready.intent.criteria.map((c) => `${c.id} ${c.text}`)).toEqual([
      "C1 The total drops to $45.00 right away",
      "C2 SAVE10 adds its own line",
    ]);
    expect(ready.intent.intentSource).toBe("linked_issue_video");
    // The hash the Cloud computes from the same ticket and recording, so a later run reuses it.
    expect(ready.intent.ticketHash).toBe(ticketHash(TICKET, [MEDIA_HASH]));
    expect(ready.coverage.items.map((i) => `${i.criterionId} ${i.status}`)).toEqual([
      "C1 covered",
      "C2 uncovered",
    ]);
    expect(port.requests.map((r) => r.stage)).toEqual(["intent", "coverage"]);
    const ask = port.requests[0]!.messages[1]!.content as { type: string }[];
    expect(ask.map((part) => part.type)).toEqual(["text", "video_url"]);
  });

  it("reads every ticket a PR names and its own criteria, merged and tagged by source", async () => {
    const UNDO = {
      ref: "#9",
      title: "Undo remove",
      body: "Undo brings the item back.",
      comments: [],
    };
    const textOf = (request: { messages: { content: unknown }[] }) => {
      const content = request.messages[1]!.content;
      return typeof content === "string" ? content : JSON.stringify(content);
    };
    const port = scriptedPort((request) => {
      if (request.stage !== "intent") return { items: [] };
      const text = textOf(request);
      if (text.includes("The header badge updates"))
        return {
          criteria: [said("The header badge updates")],
          repro: { startPath: "/cart", steps: [] },
        };
      if (text.includes("Undo brings"))
        return {
          criteria: [said("Undo restores the mug")],
          repro: { startPath: "/cart", steps: [] },
        };
      return {
        criteria: [said("The total drops"), said("SAVE10 adds its own line")],
        repro: { startPath: "/cart", steps: [] },
      };
    });
    const { ready } = await runWithBundle(
      {},
      { models: port, retryDelaysMs: [1, 1, 1, 1, 1] },
      {
        tickets: [
          { ...TICKET, video: 0 },
          { ...UNDO, video: null },
        ],
        prCriteria: ["The header badge updates"],
      },
    );
    expect(ready.intent.criteria.map((c) => `${c.id} ${c.source} ${c.text}`)).toEqual([
      "C1 #5 The total drops",
      "C2 #5 SAVE10 adds its own line",
      "C3 #9 Undo restores the mug",
      "C4 pr The header badge updates",
    ]);
    expect(ready.intent.intentSource).toBe("linked_issue_video");
    // The same hash the Cloud's bundle builder computes, so a later run reuses this intent.
    expect(ready.intent.ticketHash).toBe(
      combinedHash([
        { source: "#5", hash: ticketHash(TICKET, [MEDIA_HASH]) },
        { source: "#9", hash: ticketHash(UNDO) },
        {
          source: "pr",
          hash: ticketHash(prCriteriaTicket("Discount codes", ["The header badge updates"])),
        },
      ]),
    );
    const intentCalls = port.requests.filter((r) => r.stage === "intent");
    expect(intentCalls.map((r) => typeof r.messages[1]!.content)).toEqual([
      "object",
      "string",
      "string",
    ]);
  });

  it("reuses the intent the Cloud passed, and still maps the diff", async () => {
    const intent = {
      criteria: [{ ...said("SAVE10 adds its own line"), id: "C1", timingMs: undefined }],
      intentSource: "linked_issue_video",
      ticketHash: "e".repeat(64),
    };
    const { ready, port } = await runWithBundle({ intent });
    expect(port.requests.map((r) => r.stage)).toEqual(["coverage"]);
    expect(ready.intent.ticketHash).toBe("e".repeat(64));
  });

  it("reads the ticket's text alone when its recording can't be read", async () => {
    const { ready, port } = await runWithBundle(
      {},
      {
        readRecording: async () => {
          throw new Error("HTTP 403");
        },
      },
    );
    expect(ready.intent.intentSource).toBe("linked_issue");
    expect(typeof port.requests[0]!.messages[1]!.content).toBe("string");
  });

  it("tries a failed intent call once more (a 404 model_not_found came back once)", async () => {
    let asked = 0;
    const flaky = scriptedPort((request) => {
      if (request.stage === "intent" && asked++ === 0) return { criteria: "not a list" };
      return models()
        .call(request as never)
        .then((r) => (r.ok ? r.output : null));
    });
    const { ready } = await runWithBundle({}, { models: flaky, retryDelaysMs: [1, 1, 1, 1, 1] });
    expect(flaky.requests.map((r) => r.stage)).toEqual(["intent", "intent", "coverage"]);
    expect(ready.intent.criteria).toHaveLength(2);
  });

  it("fails the job rather than report an empty intent when the ticket can't be read", async () => {
    const broken = scriptedPort(() => ({ criteria: "not a list" }));
    await expect(
      runWithBundle({}, { models: broken, retryDelaysMs: [1, 1, 1, 1, 1] }),
    ).rejects.toThrow(/^ticket #\d+ couldn't be read: the intent call failed/);
    // A reply that didn't fit is tried once more, not waited out.
    expect(broken.requests.filter((r) => r.stage === "intent")).toHaveLength(2);
  });

  it("waits out an outage of Meta's (its 404 model_not_found, #115) before failing the job", async () => {
    // The first four intent calls fail the way the Meta port reports Meta's 404.
    const real = models();
    const stages: string[] = [];
    const outage: ModelPort = {
      async call(request) {
        stages.push(request.stage);
        if (request.stage === "intent" && stages.filter((s) => s === "intent").length <= 4) {
          const error = 'HTTP 404: {"error":{"code":"model_not_found"}}';
          return { ok: false, error, raw: error, usage: NO_USAGE, ms: 0, requests: 1 };
        }
        return real.call(request);
      },
    };
    const { ready } = await runWithBundle({}, { models: outage, retryDelaysMs: [1, 1, 1, 1, 1] });
    expect(stages.filter((s) => s === "intent")).toHaveLength(5);
    expect(ready.intent.criteria).toHaveLength(2);
  });

  describe("unrequested changes (§24, T5.6)", () => {
    // /cart on main and on almost-right, recorded; each side its own shopper, masked by name.
    const aria = (name: string) =>
      readFileSync(new URL(`../../../../fixtures/aria/${name}.yml`, import.meta.url), "utf8");
    const snapshots = (asked: string[]): Recorder => ({
      ...fakeRecorder().recorder(),
      async snapshot({ origin, route }) {
        asked.push(`${origin === BASE ? "base" : "pr"} ${route}`);
        const [text, user] =
          origin === BASE
            ? [aria("cart-main"), "shopper-763377"]
            : [aria("cart-almost-right"), "shopper-55d37f"];
        const lines = snapshotLines(text, { users: [user] });
        return { lines, touched: subtrees(lines, []) };
      },
    });
    /** The models of the other tests, and changes.v1's answer: the form is C2's, the link no one's. */
    const withChanges = () => {
      const base = models();
      const asked: string[] = [];
      const port: ModelPort = {
        async call(request) {
          asked.push(request.stage);
          if (request.stage !== "changes") return base.call(request);
          const output = {
            hunks: [
              { id: "h1", explainedBy: "C2", description: "the discount form", confidence: 0.9 },
              { id: "h2", explainedBy: null, description: "link renamed", confidence: 0.92 },
            ],
          };
          const parsed = request.schema.parse(output);
          return { ok: true, output: parsed, raw: "", usage: NO_USAGE, ms: 0, requests: 1 };
        },
      };
      return { port, asked };
    };
    const onCart = IntenzoConfig.parse({
      version: 1,
      start: { default: "/cart" },
      isolation: { session_hook: "/api/test/session" },
    });

    it("finds the renamed link on /cart and reports it in its own words", async () => {
      const visits: string[] = [];
      const { port, asked } = withChanges();
      const { events } = await runWithBundle(
        { config: onCart, baseDrift: 0 },
        { models: port, recorder: snapshots(visits) },
      );
      expect(visits).toEqual(["base /cart", "pr /cart"]);
      expect(asked.at(-1)).toBe("changes");
      expect(events.find((e) => e.kind === "changes_done")).toMatchObject({
        changes: [
          { route: "/cart", description: 'link "Checkout" → "Continue"', confidence: 0.92 },
        ],
      });
    });

    it("doesn't look on a baseline that drifted from the merge base", async () => {
      const visits: string[] = [];
      const { port, asked } = withChanges();
      const { events } = await runWithBundle(
        { config: onCart, baseDrift: 2 },
        { models: port, recorder: snapshots(visits) },
      );
      expect(visits).toEqual([]);
      expect(asked).not.toContain("changes");
      expect(events.some((e) => e.kind === "changes_done")).toBe(false);
    });
  });

  it("falls back to the demo's fixtures without a model to read the ticket", async () => {
    const { ready } = await runWithBundle({}, { models: undefined, readRecording: undefined });
    expect(ready.intent.criteria.map((c) => c.id)).toEqual(["C1", "C2", "C3", "C4"]);
    expect(ready.coverage).toEqual({ items: [], routes: [] });
  });
});
