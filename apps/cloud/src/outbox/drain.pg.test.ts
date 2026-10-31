// ROADMAP T2.4: two drainers running at once, on a real Postgres. Each claims rows through its own
// connections, so only SKIP LOCKED and the advisory locks keep them from creating a second check run
// or a second comment. GitHub answers slowly here, so their calls overlap.
import { setTimeout as sleep } from "node:timers/promises";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "../db/db.ts";
import { ensureRunGroup } from "../db/repos.ts";
import { outbox } from "../db/schema.ts";
import { resetWithDemoShop } from "../db/test-db.ts";
import { testPg } from "../db/test-pg.ts";
import { githubClient } from "../github/api.ts";
import { fakeGitHub, json } from "../github/fake-github.ts";
import { advance } from "../runs/advance.ts";
import { drainOutbox } from "./drain.ts";
import { githubExecutors } from "./github-effects.ts";
import { enqueueEffects } from "./rows.ts";

const REPO = "/repos/sumithprabhu/demo-shop";
const RUN = "00000000-0000-4000-8000-000000000001";
/** Rounds per test: the drainers' timing differs a little each time. */
const ROUNDS = 5;

const github = fakeGitHub();
let t: { db: Db; close: () => Promise<void> };
let groupId: number;
let created: string[];

beforeAll(async () => {
  t = await testPg();
}, 30_000);
afterAll(() => t?.close());
beforeEach(() => {
  created = [];
  let next = 9000;
  const create = (kind: string) => async () => {
    await sleep(100);
    created.push(kind);
    return json({ id: ++next }, 201);
  };
  const edit = async (request: Request) => {
    await sleep(50);
    return json({ id: Number(new URL(request.url).pathname.split("/").at(-1)) });
  };
  github.get(`${REPO}/commits/:sha/check-runs`, { total_count: 0, check_runs: [] });
  github.post(`${REPO}/check-runs`, create("check run"));
  github.patch(`${REPO}/check-runs/:id`, edit);
  github.get(`${REPO}/issues/7/comments`, []);
  github.post(`${REPO}/issues/7/comments`, create("comment"));
  github.patch(`${REPO}/issues/comments/:id`, edit);
});

/** A fresh PR #7 with one run, and only the outbox rows the test asks for. */
async function freshGroup() {
  const repo = await resetWithDemoShop(t.db);
  groupId = (await ensureRunGroup(t.db, repo.id, 7)).id;
  await advance(
    t.db,
    groupId,
    { kind: "pr_ready", trigger: "opened", headSha: "b4e35b0", draft: false },
    { now: new Date(), newRunId: () => RUN },
  );
  await t.db.delete(outbox);
}

const drainer = () =>
  drainOutbox({
    db: t.db,
    executors: githubExecutors({
      db: t.db,
      github: () => githubClient(async () => "ghs_test"),
      reportBaseUrl: "https://intenzo-cloud.vercel.app",
    }),
    now: () => new Date(),
    log: () => {},
  });

describe("two drainers at once (§16.4)", () => {
  it("create exactly one check run when both take one of the run's check-run effects", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await freshGroup();
      await t.db.transaction((tx) =>
        enqueueEffects(tx, groupId, [
          { kind: "check_run", runId: RUN, status: "queued" },
          { kind: "check_run", runId: RUN, status: "in_progress" },
        ]),
      );
      created = [];
      const [a, b] = await Promise.all([drainer(), drainer()]);
      expect(a.done + b.done).toBe(2);
      expect(created).toEqual(["check run"]);
    }
  });

  it("post exactly one comment when both take one of the group's comment effects", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await freshGroup();
      for (let i = 0; i < 2; i++) {
        await t.db.transaction((tx) => enqueueEffects(tx, groupId, [{ kind: "comment", groupId }]));
      }
      created = [];
      await Promise.all([drainer(), drainer()]);
      expect(created).toEqual(["comment"]);
      const rows = await t.db.select().from(outbox).where(eq(outbox.groupId, groupId));
      expect(rows.map((r) => r.status)).toEqual(["done", "done"]);
    }
  });

  it("run every row exactly once between them", async () => {
    await freshGroup();
    await t.db.transaction(async (tx) => {
      for (let i = 0; i < 6; i++) await enqueueEffects(tx, groupId, [{ kind: "comment", groupId }]);
      await enqueueEffects(tx, groupId, [
        { kind: "check_run", runId: RUN, status: "queued" },
        { kind: "check_run", runId: RUN, status: "in_progress" },
      ]);
    });
    const [a, b] = await Promise.all([drainer(), drainer()]);
    expect(a.done + b.done).toBe(8);
    const rows = await t.db.select().from(outbox);
    expect(rows.every((r) => r.status === "done" && r.attempts === 1)).toBe(true);
    expect(created.sort()).toEqual(["check run", "comment"]);
  });
});
