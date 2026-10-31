import { asc, eq } from "drizzle-orm";
import { http } from "msw/http";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureRunGroup } from "../db/repos.ts";
import { outbox, runs } from "../db/schema.ts";
import { resetWithDemoShop, testDb } from "../db/test-db.ts";
import type { ModalSettings } from "../env.ts";
import { isCurrentJob } from "../jobs/worker-api.ts";
import { verifyJobToken } from "../jobs/token.ts";
import { advance } from "../runs/advance.ts";
import type { Fact } from "../runs/transition.ts";
import { drainOutbox } from "./drain.ts";
import { jobExecutors, spawnExecutor } from "./job-effects.ts";

const MODAL: ModalSettings = {
  spawnUrl: "https://sumithprabhu--intenzo-worker-spawn.modal.run",
  cancelUrl: "https://sumithprabhu--intenzo-worker-cancel.modal.run",
  secret: "a-modal-endpoint-secret-for-tests-01234",
  cloudUrl: "https://intenzo-cloud.vercel.app",
};
const JOB_SECRET = "a-job-secret-for-tests-only-0123456789";
const T0 = new Date("2026-10-31T09:00:00.000Z");
const RUN = "00000000-0000-4000-8000-000000000001";

// Modal's two endpoints, faked: each request is recorded; one nothing answers fails the test.
const modal = setupServer();
const unanswered: string[] = [];
let calls: { endpoint: string; auth: string | null; body: any }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
beforeAll(() =>
  modal.listen({
    onUnhandledFrame({ frame, defaults }) {
      unanswered.push(String((frame.data as { request?: Request }).request?.url));
      defaults.error();
    },
  }),
);
afterEach(() => {
  modal.resetHandlers();
  const missed = unanswered.splice(0);
  if (missed.length > 0) throw new Error(`nothing answered ${missed.join(", ")}`);
});
afterAll(() => modal.close());

let t: Awaited<ReturnType<typeof testDb>>;
let groupId: number;
let ids: number;
let jobIds: number;

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  const repo = await resetWithDemoShop(t.db);
  groupId = (await ensureRunGroup(t.db, repo.id, 7)).id;
  ids = 0;
  jobIds = 0;
  calls = [];
  const record =
    (endpoint: string, answer: object) =>
    async ({ request }: { request: Request }) => {
      calls.push({
        endpoint,
        auth: request.headers.get("authorization"),
        body: await request.json(),
      });
      return Response.json(answer);
    };
  modal.use(
    http.post(MODAL.spawnUrl, record("spawn", { callId: "fc-01" })),
    http.post(MODAL.cancelUrl, record("cancel", { cancelled: "fc-01" })),
  );
  await happen({ kind: "pr_ready", trigger: "opened", headSha: "b4e35b0", draft: false });
  await happen({ kind: "preview_ready", sha: "b4e35b0", url: "https://demo-shop-x.vercel.app" });
});

const happen = (fact: Fact) =>
  advance(t.db, groupId, fact, {
    now: T0,
    newRunId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
const deps = () => ({
  db: t.db,
  modal: MODAL,
  jobSecret: JOB_SECRET,
  newJobId: () => `0b0b0b0b-0000-4000-8000-${String(++jobIds).padStart(12, "0")}`,
  now: () => T0,
});
const drain = () =>
  drainOutbox({ db: t.db, executors: jobExecutors(deps()), now: () => T0, log: () => {} });
const run = async () => (await t.db.select().from(runs).where(eq(runs.id, RUN)))[0]!;

describe("the spawn effect", () => {
  it("starts a job on Modal with a token for it, and makes it the run's current job", async () => {
    await drain();
    const job = "0b0b0b0b-0000-4000-8000-000000000001";
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      endpoint: "spawn",
      auth: `Bearer ${MODAL.secret}`,
      body: {
        type: "stub",
        jobId: job,
        runId: RUN,
        callback: { baseUrl: MODAL.cloudUrl },
      },
    });
    const deadline = (await run()).deadlineAt!;
    expect(calls[0]!.body.deadlineAt).toBe(deadline.toISOString());
    const claims = verifyJobToken(JOB_SECRET, calls[0]!.body.callback.token, T0.getTime() / 1000);
    expect(claims).toEqual({ jobId: job, runId: RUN, exp: deadline.getTime() / 1000 + 300 });
    expect(await run()).toMatchObject({ currentJobId: job, modalCallId: "fc-01" });
  });

  it("starts nothing for a run that has moved on", async () => {
    await happen({ kind: "pr_pushed", headSha: "c5f46c1", draft: false });
    await drain();
    expect(calls.map((c) => c.endpoint)).toEqual([]);
    expect((await run()).currentJobId).toBeNull();
  });

  it("makes an earlier attempt's job stale when it has to start again", async () => {
    const [row] = await t.db.select().from(outbox).where(eq(outbox.effect, "spawn_job"));
    const spawn = spawnExecutor(deps());
    await spawn.run(row!);
    const first = (await run()).currentJobId!;
    await spawn.run(row!);
    const current = await run();
    expect(current.currentJobId).not.toBe(first);
    expect(isCurrentJob(current, first)).toBe(false);
  });

  it("is tried again later when Modal refuses it", async () => {
    modal.use(http.post(MODAL.spawnUrl, () => new Response("upstream down", { status: 502 })));
    expect(await drain()).toEqual({ done: 0, failed: 1 });
    const [row] = await t.db.select().from(outbox).where(eq(outbox.effect, "spawn_job"));
    expect(row).toMatchObject({
      status: "pending",
      lastError: "Modal sumithprabhu--intenzo-worker-spawn.modal.run: 502 upstream down",
    });
  });
});

describe("the cancel effect", () => {
  it("cancels the run's Modal call when the run is superseded", async () => {
    await drain();
    await happen({ kind: "pr_pushed", headSha: "c5f46c1", draft: false });
    await drain();
    expect(calls.map((c) => `${c.endpoint} ${JSON.stringify(c.body.callId ?? "")}`)).toEqual([
      'spawn ""',
      'cancel "fc-01"',
    ]);
    // The new commit's run gets its own job once its preview is ready, not before.
    const kinds = await t.db.select().from(outbox).orderBy(asc(outbox.id));
    expect(kinds.filter((r) => r.effect === "cancel_job")).toMatchObject([{ status: "done" }]);
  });

  it("has nothing to cancel when no job was started", async () => {
    await t.db.delete(outbox).where(eq(outbox.effect, "spawn_job"));
    await happen({ kind: "pr_pushed", headSha: "c5f46c1", draft: false });
    expect(await drain()).toEqual({ done: 1, failed: 0 });
    expect(calls).toEqual([]);
  });
});
