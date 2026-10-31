import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureRunGroup } from "../db/repos.ts";
import { jobEvents, outbox, runs } from "../db/schema.ts";
import { resetWithDemoShop, testDb } from "../db/test-db.ts";
import { advance } from "../runs/advance.ts";
import type { Fact } from "../runs/transition.ts";
import { signJobToken } from "./token.ts";
import {
  handleAlive,
  handleWorkerEvent,
  MAX_EVENT_BYTES,
  type WorkerApiDeps,
} from "./worker-api.ts";

const SECRET = "a-job-secret-for-tests-only-0123456789";
const NOW = new Date("2026-10-31T09:00:00.000Z");
const RUN = "00000000-0000-4000-8000-000000000001";
const JOB = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
const PREVIEW = "https://demo-shop-60b7pwtbw-sumithprabhus-projects.vercel.app";

let t: Awaited<ReturnType<typeof testDb>>;
let groupId: number;
let ids: number;
let drains: number;
let lines: string[];

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  const repo = await resetWithDemoShop(t.db);
  groupId = (await ensureRunGroup(t.db, repo.id, 7)).id;
  ids = 0;
  drains = 0;
  lines = [];
  await happen({ kind: "pr_ready", trigger: "opened", headSha: "b4e35b0", draft: false });
  await happen({ kind: "preview_ready", sha: "b4e35b0", url: PREVIEW });
  // T2.5b's spawn effect will set this; here the job is made current by hand.
  await t.db.update(runs).set({ currentJobId: JOB }).where(eq(runs.id, RUN));
});

const happen = (fact: Fact) =>
  advance(t.db, groupId, fact, {
    now: NOW,
    newRunId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
const deps = (): WorkerApiDeps => ({
  db: t.db,
  secret: SECRET,
  now: () => NOW,
  newRunId: () => crypto.randomUUID(),
  drain: async () => (drains += 1),
  log: (line) => lines.push(line),
});
const TOKEN = signJobToken(SECRET, { jobId: JOB, runId: RUN, exp: NOW.getTime() / 1000 + 600 });
const send = (body: unknown, token: string | null = TOKEN) =>
  handleWorkerEvent(
    new Request("https://intenzo-cloud.vercel.app/api/worker/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token && { authorization: `Bearer ${token}` }),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    deps(),
  );
const alive = (token: string | null = TOKEN) =>
  handleAlive(
    new Request("https://intenzo-cloud.vercel.app/api/worker/alive", {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    deps(),
  );
const started = (seq = 0) => ({ kind: "started", jobId: JOB, seq });
const run = async () => (await t.db.select().from(runs).where(eq(runs.id, RUN)))[0]!;
const stored = () => t.db.select().from(jobEvents);

describe("POST /api/worker/events (§9)", () => {
  it("stores the current job's event once: a repeated seq is ignored", async () => {
    expect((await send(started())).status).toBe(202);
    const again = await send(started());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "duplicate" });
    expect(await stored()).toMatchObject([{ jobId: JOB, runId: RUN, seq: 0, kind: "started" }]);
  });

  it("answers 410 to a job whose run was superseded, and stores nothing", async () => {
    await happen({ kind: "pr_pushed", headSha: "c5f46c1", draft: false });
    expect((await send(started())).status).toBe(410);
    expect((await alive()).status).toBe(410);
    expect(await stored()).toEqual([]);
    expect(lines).toEqual([
      `run ${RUN.slice(0, 8)}: job ${JOB.slice(0, 8)} started #0 refused: the job isn't current (410)`,
    ]);
  });

  it("answers 410 to a job that isn't its run's current one", async () => {
    await t.db
      .update(runs)
      .set({ currentJobId: "0a1b2c3d-0000-4000-8000-000000000000" })
      .where(eq(runs.id, RUN));
    expect((await send(started())).status).toBe(410);
  });

  it.each([
    ["no token", started(), null, 401],
    [
      "a token signed with another secret",
      started(),
      signJobToken("x".repeat(40), { jobId: JOB, runId: RUN, exp: 2e9 }),
      401,
    ],
    [
      "an expired token",
      started(),
      signJobToken(SECRET, { jobId: JOB, runId: RUN, exp: NOW.getTime() / 1000 }),
      401,
    ],
    [
      "another job's event",
      { ...started(), jobId: "0a1b2c3d-0000-4000-8000-000000000000" },
      TOKEN,
      403,
    ],
    ["a body that isn't an event", { kind: "hello" }, TOKEN, 400],
    ["a body that isn't JSON", "{", TOKEN, 400],
    ["a body over 1 MB", "x".repeat(MAX_EVENT_BYTES + 1), TOKEN, 413],
  ] as const)("refuses %s", async (_name, body, token, status) => {
    expect((await send(body, token)).status).toBe(status);
    expect(await stored()).toEqual([]);
  });

  it("ends the run with a finished event's outcome, and drains the outbox", async () => {
    const finished = {
      kind: "finished",
      jobId: JOB,
      seq: 4,
      outcome: "pass",
      costUsd: 0.31,
      timings: {},
    };
    expect((await send(finished)).status).toBe(202);
    expect(await run()).toMatchObject({ state: "done", outcome: "pass", finishedAt: NOW });
    expect(drains).toBe(1);
    const keys = (await t.db.select().from(outbox)).map((r) => r.idemKey);
    expect(keys).toContain(`check:${RUN}:completed`);
    expect(keys).not.toContain(`cancel:${RUN}`);
    // The job is over: what it sends next is refused.
    expect((await send(started(5))).status).toBe(410);
  });

  it("ends the run cancelled when the shim reports the job cancelled", async () => {
    const failed = {
      kind: "failed",
      jobId: JOB,
      seq: 1_000_000,
      error: { code: "cancelled", message: "cancelled by Modal" },
    };
    expect((await send(failed)).status).toBe(202);
    expect(await run()).toMatchObject({
      state: "done",
      outcome: "cancelled",
      outcomeReason: "worker_failed",
    });
  });
});

describe("GET /api/worker/alive", () => {
  it("is 200 while the job is current, and 401 without a valid token", async () => {
    const answer = await alive();
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ alive: true });
    expect((await alive(null)).status).toBe(401);
  });
});
