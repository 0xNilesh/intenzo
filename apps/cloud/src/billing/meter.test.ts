import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { renderComment } from "@intenzo/core";

import { ensureRunGroup } from "../db/repos.ts";
import { criteriaResults, runGroups } from "../db/schema.ts";
import { resetWithDemoShop, testDb } from "../db/test-db.ts";
import { reportModel } from "../report/model.ts";
import { advance } from "../runs/advance.ts";
import type { Fact } from "../runs/transition.ts";
import { billingUnits } from "./meter.ts";

const T0 = Date.parse("2026-11-01T09:00:00.000Z");
const runId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let t: Awaited<ReturnType<typeof testDb>>;
let groupId: number;
let ids: number;
let minute: number;

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  const repo = await resetWithDemoShop(t.db);
  groupId = (await ensureRunGroup(t.db, repo.id, 7)).id;
  ids = 0;
  minute = 0;
});

const happen = (fact: Fact) =>
  advance(t.db, groupId, fact, {
    now: new Date(T0 + minute * 60_000),
    newRunId: () => runId(++ids),
  });

type Judged = "pass" | "fail" | "inconclusive";

/** A run on a new commit that finishes with these verdicts (inconclusive ones as setup_failed). */
async function run(verdicts: readonly Judged[], outcome: "pass" | "fail" | "inconclusive") {
  const sha = (ids + 1).toString(16).padStart(40, "a");
  minute += 10;
  await happen(
    ids === 0
      ? { kind: "pr_ready", trigger: "opened", headSha: sha, draft: false }
      : { kind: "pr_pushed", headSha: sha, draft: false },
  );
  await happen({ kind: "preview_ready", sha, url: `https://shop-${ids}.vercel.app` });
  const id = runId(ids);
  for (const [i, verdict] of verdicts.entries()) {
    await t.db.insert(criteriaResults).values({
      runId: id,
      criterionId: `C${i + 1}`,
      verdict,
      reasonCode: verdict === "inconclusive" ? "setup_failed" : "agreed",
      judgesJson: [],
      lanesJson: [],
      evidenceJson: {},
    });
  }
  minute += 2;
  await happen({ kind: "job_finished", runId: id, outcome });
  return id;
}

const group = async () =>
  (await t.db.select().from(runGroups).where(eq(runGroups.id, groupId)))[0]!;

describe("the billing meter (§16.3)", () => {
  it("never bills a group whose runs judged nothing", async () => {
    await run(["inconclusive", "inconclusive"], "inconclusive");
    await run(["inconclusive"], "inconclusive");
    expect(await group()).toMatchObject({ judgedRuns: 0, billedAt: null });
  });

  it("bills the group once, when a run first judges a criterion pass or fail", async () => {
    await run(["inconclusive"], "inconclusive");
    await run(["fail", "pass", "inconclusive"], "fail");
    const first = await group();
    // Billed when that run finished: minute 24 (the first run took minutes 10–12, this one 22–24).
    expect(first).toMatchObject({ judgedRuns: 1, billedAt: new Date(T0 + 24 * 60_000) });
    await run(["pass"], "pass");
    const second = await group();
    expect(second.judgedRuns).toBe(2);
    expect(second.billedAt).toEqual(first.billedAt);
    expect(billingUnits(second.judgedRuns)).toBe(1);
  });

  it("adds a second unit with the 6th judged run", async () => {
    for (let n = 0; n < 5; n++) await run(["fail"], "fail");
    expect(billingUnits((await group()).judgedRuns)).toBe(1);
    await run(["pass"], "pass");
    expect((await group()).judgedRuns).toBe(6);
    expect(billingUnits(6)).toBe(2);
  });

  it("counts units as 1–5 → 1, 6–10 → 2, none → 0", () => {
    expect([0, 1, 5, 6, 10, 11].map(billingUnits)).toEqual([0, 1, 1, 2, 2, 3]);
  });

  it("shows the units in the comment's footer once billed", async () => {
    await run(["inconclusive"], "inconclusive");
    let text = renderComment((await reportModel(t.db, groupId, "https://intenzo.example"))!);
    expect(text).not.toContain("🧾");
    await run(["fail"], "fail");
    text = renderComment((await reportModel(t.db, groupId, "https://intenzo.example"))!);
    expect(text).toContain("🧾 1 unit (1 judged run)");
  });
});
