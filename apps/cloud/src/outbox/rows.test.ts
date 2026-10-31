import { asc } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureRunGroup } from "../db/repos.ts";
import { outbox } from "../db/schema.ts";
import { resetWithDemoShop, testDb } from "../db/test-db.ts";
import { advance } from "../runs/advance.ts";
import type { Effect } from "../runs/transition.ts";
import { enqueueEffects, outboxRows } from "./rows.ts";

const AT = Date.parse("2026-10-31T09:00:00.000Z");
const RUN = "00000000-0000-4000-8000-000000000001";
const URL_A = "https://demo-shop-60b7pwtbw-sumithprabhus-projects.vercel.app";

describe("outboxRows (§16.4 idempotency keys)", () => {
  it.each<[Effect, string, string | null]>([
    [{ kind: "check_run", runId: RUN, status: "queued" }, `check:${RUN}:queued`, RUN],
    [
      { kind: "check_run", runId: RUN, status: "completed", conclusion: "neutral" },
      `check:${RUN}:completed`,
      RUN,
    ],
    [{ kind: "comment", groupId: 7 }, "comment:7:3", null],
    [{ kind: "spawn_job", runId: RUN }, `spawn:${RUN}:verify`, RUN],
    [{ kind: "cancel_job", runId: RUN }, `cancel:${RUN}`, RUN],
  ])("%j → %s", (effect, idemKey, runId) => {
    expect(outboxRows(7, [effect], 3)).toEqual([
      { runId, groupId: 7, effect: effect.kind, idemKey, payloadJson: effect },
    ]);
  });
});

describe("advance() and the outbox", () => {
  let t: Awaited<ReturnType<typeof testDb>>;
  let groupId: number;
  let ids = 0;
  const at = (minute: number) => ({
    now: new Date(AT + minute * 60_000),
    newRunId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
  const keys = async () =>
    (await t.db.select().from(outbox).orderBy(asc(outbox.id))).map((r) => r.idemKey);

  beforeAll(async () => {
    t = await testDb();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    const repo = await resetWithDemoShop(t.db);
    groupId = (await ensureRunGroup(t.db, repo.id, 7)).id;
    ids = 0;
  });

  it("writes every effect of each decision, numbering the group's comments", async () => {
    await advance(
      t.db,
      groupId,
      { kind: "pr_ready", trigger: "opened", headSha: "b4e35b0", draft: false },
      at(0),
    );
    await advance(t.db, groupId, { kind: "preview_ready", sha: "b4e35b0", url: URL_A }, at(1));
    await advance(t.db, groupId, { kind: "pr_pushed", headSha: "c5f46c1", draft: false }, at(2));
    const run1 = "00000000-0000-4000-8000-000000000001";
    const run2 = "00000000-0000-4000-8000-000000000002";
    expect(await keys()).toEqual([
      `check:${run1}:queued`,
      `comment:${groupId}:1`,
      `check:${run1}:in_progress`,
      `spawn:${run1}:verify`,
      `comment:${groupId}:2`,
      `cancel:${run1}`,
      `check:${run1}:completed`,
      `check:${run2}:queued`,
      `comment:${groupId}:3`,
    ]);
    const rows = await t.db.select().from(outbox);
    expect(new Set(rows.map((r) => `${r.status}/${r.attempts}`))).toEqual(new Set(["pending/0"]));
  });

  it("writes nothing for a fact that changes nothing", async () => {
    await advance(t.db, groupId, { kind: "tick" }, at(0));
    expect(await keys()).toEqual([]);
  });

  it("skips a key that's already queued", async () => {
    await advance(
      t.db,
      groupId,
      { kind: "pr_ready", trigger: "opened", headSha: "b4e35b0", draft: false },
      at(0),
    );
    const again: Effect[] = [{ kind: "check_run", runId: RUN, status: "queued" }];
    await t.db.transaction((tx) => enqueueEffects(tx, groupId, again));
    expect(await keys()).toEqual([`check:${RUN}:queued`, `comment:${groupId}:1`]);
  });
});
