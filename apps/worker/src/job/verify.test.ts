import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IntenzoConfig, LaneResult, WorkerEvent } from "@intenzo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { jobClient } from "./client.ts";
import { EXIT, runJob } from "./run.ts";
import type { LaneInput, Recorder } from "./verify.ts";

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
async function fakeCloud({ existing = [] as string[], gone = false } = {}) {
  const events: WorkerEvent[] = [];
  const stored = new Set(existing);
  const puts: { path: string; type: string | undefined; bytes: number }[] = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const { pathname } = new URL(req.url!, "http://cloud");
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
  });

type Verdicts = Extract<WorkerEvent, { kind: "criterion_verdict" }>[];
const verdictsOf = (events: WorkerEvent[]) =>
  events.filter((e) => e.kind === "criterion_verdict") as Verdicts;

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
    expect(fake.asked.map((a) => `${a.criterion.id} ${a.side} ${a.origin}`)).toEqual(
      ["C1", "C2", "C3", "C4"].flatMap((id) => [`${id} pr ${PR}`, `${id} base ${BASE}`]),
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
