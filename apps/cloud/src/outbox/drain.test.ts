import { asc } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureRunGroup } from "../db/repos.ts";
import { outbox } from "../db/schema.ts";
import { resetWithDemoShop, testDb } from "../db/test-db.ts";
import {
  backoffMs,
  claimNext,
  drainOutbox,
  type EffectExecutor,
  LEASE_MS,
  MAX_ATTEMPTS,
} from "./drain.ts";

const T0 = Date.parse("2026-10-31T09:00:00.000Z");

let t: Awaited<ReturnType<typeof testDb>>;
let groupId: number;
let ran: string[];
let lines: string[];

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  const repo = await resetWithDemoShop(t.db);
  groupId = (await ensureRunGroup(t.db, repo.id, 7)).id;
  ran = [];
  lines = [];
});

const queue = (...effects: string[]) =>
  t.db.insert(outbox).values(
    effects.map((effect, i) => ({
      groupId,
      effect,
      idemKey: `${effect}:${i}`,
      payloadJson: { effect },
    })),
  );
const rows = () => t.db.select().from(outbox).orderBy(asc(outbox.id));

/** An executor that records each row it runs, then does what `outcome` says. */
const recording = (
  outcome: () => string | null = () => null,
  atMostOnce = false,
): EffectExecutor => ({
  atMostOnce,
  run: async (row) => {
    ran.push(row.idemKey);
    return outcome();
  },
});
const failing = (atMostOnce = false) =>
  recording(() => {
    throw new Error("GitHub said 502");
  }, atMostOnce);

const drain = (executors: Record<string, EffectExecutor>, ms = 0) =>
  drainOutbox({ db: t.db, executors, now: () => new Date(T0 + ms), log: (l) => lines.push(l) });

describe("drainOutbox (§16.4)", () => {
  it("runs each due row once, oldest first, and records it done with the id it produced", async () => {
    await queue("check_run", "comment");
    const executors = { check_run: recording(() => "1234"), comment: recording(() => "5678") };
    expect(await drain(executors)).toEqual({ done: 2, failed: 0 });
    expect(await drain(executors)).toEqual({ done: 0, failed: 0 });
    expect(ran).toEqual(["check_run:0", "comment:1"]);
    expect(await rows()).toMatchObject([
      { status: "done", attempts: 1, externalId: "1234", leaseUntil: null },
      { status: "done", attempts: 1, externalId: "5678", leaseUntil: null },
    ]);
  });

  it("leaves effects it has no executor for pending", async () => {
    await queue("spawn_job", "comment");
    await drain({ comment: recording() });
    expect(await rows()).toMatchObject([
      { effect: "spawn_job", status: "pending", attempts: 0 },
      { effect: "comment", status: "done" },
    ]);
  });

  it("retries a failed effect after its backoff, and gives up after 5 attempts", async () => {
    await queue("comment");
    const executors = { comment: failing() };
    let at = 0;
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await drain(executors, at);
      const [row] = await rows();
      expect(row).toMatchObject({
        status: "pending",
        attempts: attempt,
        lastError: "GitHub said 502",
      });
      // Not before its backoff is over.
      await drain(executors, at + backoffMs(attempt) - 1);
      expect(ran).toHaveLength(attempt);
      at += backoffMs(attempt);
    }
    await drain(executors, at);
    expect(await rows()).toMatchObject([{ status: "failed", attempts: MAX_ATTEMPTS }]);
    await drain(executors, at + 3_600_000);
    expect(ran).toHaveLength(MAX_ATTEMPTS);
    expect(lines.at(-1)).toBe("outbox comment:0: attempt 5 failed, giving up: GitHub said 502");
  });

  it("runs a row again once the lease of a drainer that died has run out", async () => {
    await queue("check_run");
    // A drainer claims the row and dies before finishing it.
    expect(await claimNext(t.db, ["check_run"], [], new Date(T0))).toMatchObject({
      status: "in_flight",
      attempts: 1,
    });
    const executors = { check_run: recording(() => "1234") };
    await drain(executors, LEASE_MS - 1);
    expect(ran).toEqual([]);
    await drain(executors, LEASE_MS + 1);
    expect(ran).toEqual(["check_run:0"]);
    expect(await rows()).toMatchObject([{ status: "done", attempts: 2, externalId: "1234" }]);
  });

  it("marks an at-most-once effect done before running it: a failure is never repeated", async () => {
    await queue("agent_mention");
    const executors = { agent_mention: failing(true) };
    expect(await drain(executors)).toEqual({ done: 0, failed: 1 });
    await drain(executors, 3_600_000);
    expect(ran).toEqual(["agent_mention:0"]);
    expect(await rows()).toMatchObject([
      { status: "done", attempts: 1, lastError: "GitHub said 502" },
    ]);
  });

  it("claims an at-most-once row as done, so a drainer that dies mid-way loses it", async () => {
    await queue("agent_mention");
    await claimNext(t.db, ["agent_mention"], ["agent_mention"], new Date(T0));
    await drain({ agent_mention: recording(() => null, true) }, LEASE_MS + 1);
    expect(ran).toEqual([]);
    expect(await rows()).toMatchObject([{ status: "done", attempts: 1 }]);
  });
});
