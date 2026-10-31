import { readFileSync } from "node:fs";

import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureRunGroup } from "../db/repos.ts";
import {
  criteriaResults,
  intentVersions,
  jobEvents,
  outbox,
  runs,
  savedPaths,
} from "../db/schema.ts";
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
      costUsd: 0.1044,
      timings: { total_ms: 68_000 },
    };
    expect((await send(finished)).status).toBe(202);
    expect(await run()).toMatchObject({ state: "done", outcome: "pass", finishedAt: NOW });
    // §26.1's final stage shows the cost and the time: they're kept on the run.
    expect(await run()).toMatchObject({ costUsd: 0.1044, timingsJson: { total_ms: 68_000 } });
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

describe("the events that add to the report (§9, §26.1)", () => {
  const FIXTURES = new URL("../../../../fixtures/criteria/", import.meta.url);
  const criteria = ["C1", "C2"].map((id) =>
    JSON.parse(readFileSync(new URL(`${id}.json`, FIXTURES), "utf8")),
  );
  const intent = { criteria, intentSource: "linked_issue", ticketHash: "b".repeat(64) };
  const coverage = { items: [], routes: ["/cart"] };
  const judge = {
    model: "stub",
    verdict: "fail",
    targetCorrect: true,
    citedReadings: [],
    citedValue: null,
    atMs: null,
    observed: "The total stayed $50.00.",
  };
  const verdict = {
    criterionId: "C2",
    verdict: "fail",
    reasonCode: "agreed",
    evidenceWindow: { startMs: 1_000, endMs: 5_000 },
    observed: "The total stayed $50.00.",
    judges: [judge, judge],
  };
  const comments = async () =>
    (await t.db.select().from(outbox).orderBy(asc(outbox.id)))
      .filter((r) => r.effect === "comment")
      .map((r) => r.idemKey);

  it("keeps a path_saved for the group's later runs, without re-rendering the comment", async () => {
    const path = (name: string) => ({
      criterionId: "C2",
      setup: [{ op: "goto", path: "/cart" }],
      trigger: [{ op: "click", target: { by: "role", role: "button", name } }],
      watch: [{ label: "summary", scope: "region", target: { by: "testId", id: "summary" } }],
      portable: true,
    });
    // Before the intent, the path has no intent version to belong to.
    expect(
      (await send({ kind: "path_saved", jobId: JOB, seq: 1, path: path("Apply") })).status,
    ).toBe(202);
    expect(await t.db.select().from(savedPaths)).toEqual([]);
    expect(lines.some((l) => l.includes("path for C2 dropped"))).toBe(true);

    await send({ kind: "intent_ready", jobId: JOB, seq: 2, intent, coverage });
    const before = (await comments()).length;
    await send({ kind: "path_saved", jobId: JOB, seq: 3, path: path("Apply") });
    await send({ kind: "path_saved", jobId: JOB, seq: 4, path: path("Redeem") });
    const intentVersionId = (await t.db.select().from(intentVersions))[0]!.id;
    expect(await t.db.select().from(savedPaths)).toMatchObject([
      { runGroupId: groupId, criterionId: "C2", intentVersionId, pathJson: path("Redeem") },
    ]);
    expect((await comments()).length).toBe(before);
  });

  it("stores the criteria, a verdict and its evidence, re-rendering the comment after each", async () => {
    const before = (await comments()).length;
    await send({ kind: "intent_ready", jobId: JOB, seq: 1, intent, coverage });
    const [stored] = await t.db.select().from(intentVersions);
    expect(stored).toMatchObject({ ticketHash: intent.ticketHash });
    expect((await run()).intentVersionId).toBe(stored!.id);

    expect(
      (await send({ kind: "criterion_verdict", jobId: JOB, seq: 2, verdict, lanes: [] })).status,
    ).toBe(202);
    const gif = { store: "public", path: `runs/${RUN}/C2/evidence.gif`, contentType: "image/gif" };
    const still = { store: "public", path: `runs/${RUN}/C2/still.png`, contentType: "image/png" };
    await send({ kind: "criterion_evidence", jobId: JOB, seq: 3, criterionId: "C2", gif, still });
    expect(await t.db.select().from(criteriaResults)).toMatchObject([
      {
        runId: RUN,
        criterionId: "C2",
        verdict: "fail",
        reasonCode: "agreed",
        evidenceJson: { window: verdict.evidenceWindow, observed: verdict.observed, gif, still },
      },
    ]);
    // One comment re-render per event, and a drain to post it.
    expect((await comments()).length).toBe(before + 3);
    expect(drains).toBe(3);
  });

  it("replaces a criterion's verdict when it's judged again, keeping its evidence", async () => {
    await send({ kind: "criterion_verdict", jobId: JOB, seq: 1, verdict, lanes: [] });
    const gif = { store: "public", path: `runs/${RUN}/C2/evidence.gif`, contentType: "image/gif" };
    await send({
      kind: "criterion_evidence",
      jobId: JOB,
      seq: 2,
      criterionId: "C2",
      gif,
      still: gif,
    });
    const passing = {
      ...verdict,
      verdict: "pass",
      observed: "It changed to $45.00.",
      judges: [
        { ...judge, verdict: "pass" },
        { ...judge, verdict: "pass" },
      ],
    };
    await send({ kind: "criterion_verdict", jobId: JOB, seq: 3, verdict: passing, lanes: [] });
    const [row] = await t.db.select().from(criteriaResults);
    expect(row).toMatchObject({
      verdict: "pass",
      evidenceJson: { observed: "It changed to $45.00.", gif },
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
