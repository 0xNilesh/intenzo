import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IntenzoConfig, LaneResult, type SavedPath, WorkerEvent } from "@intenzo/core";
import type { ExploreResult } from "@intenzo/core/navigator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { jobClient } from "./client.ts";
import { EXIT, runJob } from "./run.ts";
import type { ExploreInput, LaneInput, Recorder } from "./verify.ts";

// The verify job with the navigator (T3.5, §19 3a–b): cached paths replay, missing ones are
// explored and saved back to the Cloud (path_saved), and broken ones are explored again.

const JOB = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
const RUN = "ea44d35d-4baa-4f81-ac92-08285fae4058";
const PR = "https://demo-shop-git-intenzo-check-sumithprabhus-projects.vercel.app";
const BASE = "https://demo-shop-git-main-sumithprabhus-projects.vercel.app";
const T0 = 1_900_000_000_000;

let server: Server | undefined;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "intenzo-navigate-test-"));
});
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

/** The Cloud's worker routes and Blob's PUTs on one local port. */
async function fakeCloud() {
  const events: WorkerEvent[] = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    const { pathname } = new URL(req.url!, "http://cloud");
    const reply = (status: number, value: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (pathname === "/api/worker/events") {
      events.push(WorkerEvent.parse(JSON.parse(body)));
      return reply(202, {});
    }
    if (pathname === "/api/worker/alive") return reply(200, {});
    if (pathname === "/api/worker/upload-tokens") {
      const { files } = JSON.parse(body) as { files: { path: string }[] };
      return reply(200, {
        uploads: files.map((f) => ({
          ...f,
          uploadUrl: `${base}/blob/${f.path}`,
          validUntil: "2026-10-31T10:00:00.000Z",
        })),
      });
    }
    return reply(200, {});
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return { base, events };
}

const pathFor = (id: string, button: string): SavedPath => ({
  criterionId: id,
  setup: [{ op: "goto", path: "/cart" }],
  trigger: [{ op: "click", target: { by: "role", role: "button", name: button } }],
  watch: [{ label: "summary", scope: "region", target: { by: "testId", id: "summary" } }],
  portable: true,
});
const button = (p: SavedPath) => (p.trigger[0] as { target: { name: string } }).target.name;

function lane(
  id: string,
  side: "pr" | "base",
  status: LaneResult["status"],
  failedStepIndex?: number,
) {
  const done = status === "completed";
  return LaneResult.parse({
    criterionId: id,
    side,
    status,
    ...(failedStepIndex !== undefined && { failedStepIndex }),
    laneStartMs: T0,
    tTriggerMs: done ? T0 + 5000 : null,
    stepLog: [
      { tMs: T0 + 1000, step: { op: "goto", path: "/cart" }, ok: true },
      // The trigger step ran (and set Tt) or failed (no Tt), so failedStepIndex 1 points at it.
      {
        tMs: T0 + 5000,
        step: { op: "click", target: { by: "testId", id: "apply" } },
        ok: done,
        trigger: true,
        ...(!done && { error: "no button" }),
      },
    ],
    readings: [],
    consoleErrorCount: 0,
    failedRequestCount: 0,
    isolation: "ephemeral_user",
  });
}

const notFound = (status: "setup_failed" | "trigger_absent", reason: string): ExploreResult => ({
  status,
  reason,
  steps: [],
  ms: 1,
  usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0 },
  modelCalls: 1,
});

/**
 * A recorder that can explore. The PR app's Apply button is called `liveButton`: a replay of a
 * path that clicks anything else breaks at that step. Exploring finds `liveButton`, except for
 * the criteria in `unreachable`.
 */
function navigatingRecorder(liveButton: string, unreachable: string[] = []) {
  const recorded: LaneInput[] = [];
  const explored: ExploreInput[] = [];
  const recorder = (): Recorder => ({
    async record(input) {
      recorded.push(input);
      const id = input.criterion.id;
      const status =
        input.side === "base"
          ? "trigger_absent"
          : button(input.path) === liveButton
            ? "completed"
            : "trigger_absent";
      const humanFile = join(dir, `${id}-${input.side}-${recorded.length}.mp4`);
      writeFileSync(humanFile, "video");
      return {
        lane: lane(id, input.side, status, status === "trigger_absent" ? 1 : undefined),
        video: { humanFile, offsets: { human: -T0, judge: -T0 } },
      };
    },
    async explore(input) {
      explored.push(input);
      const id = input.criterion.id;
      if (unreachable.includes(id)) return notFound("trigger_absent", "no discount field");
      return {
        status: "found",
        path: pathFor(id, liveButton),
        steps: [],
        ms: 1,
        usage: notFound("setup_failed", "").usage,
        modelCalls: 2,
      };
    },
    async close() {},
  });
  return { recorder, recorded, explored };
}

const job = (callback: string, cachedPaths: SavedPath[] = []) => ({
  type: "verify",
  jobId: JOB,
  runId: RUN,
  deadlineAt: "2026-10-31T09:15:00.000Z",
  callback: { baseUrl: callback, token: "job-token" },
  config: IntenzoConfig.parse({
    version: 1,
    isolation: { session_hook: "/api/test/session" },
    start: { default: "/cart" },
  }),
  bundleUrl: null,
  intent: null,
  prUrl: PR,
  baseUrl: BASE,
  baseSha: "b6b60c7dde0123456789abcdef0123456789abcd",
  secrets: { hookSecret: "hook-secret-for-the-test-0123456789" },
  cachedPaths,
});

const run = (j: unknown, recorder: () => Recorder) =>
  runJob(j, { client: (x) => jobClient(x, { retryDelayMs: 1 }), recorder, log: () => {} });

describe("the verify job with the navigator", () => {
  it("explores every criterion when nothing is cached, saves the paths and replays them on both sides", async () => {
    const cloud = await fakeCloud();
    const fake = navigatingRecorder("Apply");
    expect(await run(job(cloud.base), fake.recorder)).toBe(EXIT.finished);

    expect(fake.explored.map((e) => `${e.criterion.id} ${e.origin}`)).toEqual(
      ["C1", "C2", "C3", "C4"].map((id) => `${id} ${PR}`),
    );
    expect(fake.explored[0]).toMatchObject({
      identity: { hookPath: "/api/test/session" },
      config: { start: { default: "/cart" } },
    });
    const saved = cloud.events.filter((e) => e.kind === "path_saved");
    expect(saved.map((e) => e.kind === "path_saved" && e.path.criterionId)).toEqual([
      "C1",
      "C2",
      "C3",
      "C4",
    ]);
    // No hand-written path is used: every recording follows an explored path.
    expect(fake.recorded.map((r) => `${r.criterion.id} ${r.side} ${button(r.path)}`)).toEqual(
      ["C1", "C2", "C3", "C4"].flatMap((id) => [`${id} pr Apply`, `${id} base Apply`]),
    );
  });

  it("replays cached paths without exploring", async () => {
    const cloud = await fakeCloud();
    const fake = navigatingRecorder("Apply");
    const cached = ["C1", "C2", "C3", "C4"].map((id) => pathFor(id, "Apply"));
    await run(job(cloud.base, cached), fake.recorder);
    expect(fake.explored).toEqual([]);
    expect(cloud.events.some((e) => e.kind === "path_saved")).toBe(false);
  });

  it("explores again when a cached path breaks, and uploads the new recording as take 2", async () => {
    const cloud = await fakeCloud();
    const fake = navigatingRecorder("Redeem");
    await run(job(cloud.base, [pathFor("C2", "Apply")]), fake.recorder);
    const c2 = fake.recorded
      .filter((r) => r.criterion.id === "C2")
      .map((r) => `${r.side} ${button(r.path)}`);
    expect(c2).toEqual(["pr Apply", "pr Redeem", "base Redeem"]);
    expect(
      cloud.events.filter((e) => e.kind === "path_saved" && e.path.criterionId === "C2"),
    ).toHaveLength(1);
    const verdict = cloud.events.find(
      (e) => e.kind === "criterion_verdict" && e.verdict.criterionId === "C2",
    );
    expect(verdict).toMatchObject({
      lanes: [{ side: "pr", status: "completed" }, { side: "base" }],
    });
  });

  it("reports the navigator's reason when it can't reach the trigger, and records no base side", async () => {
    const cloud = await fakeCloud();
    const fake = navigatingRecorder("Apply", ["C3"]);
    await run(job(cloud.base), fake.recorder);
    expect(fake.recorded.some((r) => r.criterion.id === "C3")).toBe(false);
    const c3 = cloud.events.find(
      (e) => e.kind === "criterion_verdict" && e.verdict.criterionId === "C3",
    );
    expect(c3).toMatchObject({
      lanes: [],
      verdict: {
        verdict: "inconclusive",
        reasonCode: "precondition_unmet",
        observed:
          "Not judged: the navigator couldn't reach the trigger (trigger_absent: no discount field).",
      },
    });
  });
});
