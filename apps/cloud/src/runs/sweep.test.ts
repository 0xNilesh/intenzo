import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureRunGroup } from "../db/repos.ts";
import { outbox, runs } from "../db/schema.ts";
import { resetWithDemoShop, testDb } from "../db/test-db.ts";
import { advance } from "./advance.ts";
import { handleSweep } from "./sweep.ts";
import type { Fact } from "./transition.ts";

const SECRET = "a-sweep-secret-for-tests-only-012345678";
const T0 = Date.parse("2026-10-31T09:00:00.000Z");
const RUN = "00000000-0000-4000-8000-000000000001";

let t: Awaited<ReturnType<typeof testDb>>;
let groupId: number;
let ids: number;
let drains: number;

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  const repo = await resetWithDemoShop(t.db);
  groupId = (await ensureRunGroup(t.db, repo.id, 7)).id;
  ids = 0;
  drains = 0;
});

const at = (minute: number) => new Date(T0 + minute * 60_000);
const happen = (fact: Fact, minute = 0) =>
  advance(t.db, groupId, fact, {
    now: at(minute),
    newRunId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
const sweep = async (minute: number, token: string | null = SECRET, configured = true) => {
  const response = await handleSweep(
    new Request("https://intenzo-cloud.vercel.app/api/internal/sweep", {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    {
      db: t.db,
      secret: configured ? SECRET : undefined,
      now: () => at(minute),
      newRunId: () => crypto.randomUUID(),
      drain: async () => (drains += 1),
      log: () => {},
    },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};
const run = async () => (await t.db.select().from(runs).where(eq(runs.id, RUN)))[0]!;
const opened: Fact = { kind: "pr_ready", trigger: "opened", headSha: "b4e35b0", draft: false };

describe("POST /api/internal/sweep (§12)", () => {
  it("refuses everyone until its secret is set, then anyone without it", async () => {
    expect((await sweep(0, SECRET, false)).status).toBe(503);
    expect((await sweep(0, null)).status).toBe(401);
    expect((await sweep(0, `${SECRET}x`)).status).toBe(401);
    expect(drains).toBe(0);
  });

  it("ends a run whose preview never came within 20 minutes, and drains the outbox", async () => {
    await happen(opened);
    expect((await sweep(19)).body).toMatchObject({ groups: 1, changed: 0 });
    expect((await sweep(20)).body).toMatchObject({ groups: 1, changed: 1 });
    expect(await run()).toMatchObject({
      state: "done",
      outcome: "inconclusive",
      outcomeReason: "preview_not_ready",
    });
    expect(drains).toBe(2);
    expect((await sweep(21)).body).toMatchObject({ groups: 0, changed: 0 });
  });

  it("stops a run still verifying 15 minutes after it started, and cancels its job", async () => {
    await happen(opened);
    await happen(
      { kind: "preview_ready", sha: "b4e35b0", url: "https://demo-shop-x.vercel.app" },
      1,
    );
    await sweep(16);
    expect(await run()).toMatchObject({
      state: "done",
      outcome: "error",
      outcomeReason: "deadline_passed",
    });
    const keys = (await t.db.select().from(outbox)).map((r) => r.idemKey);
    expect(keys).toContain(`cancel:${RUN}`);
  });
});
