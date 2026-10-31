import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureRunGroup } from "../db/repos.ts";
import { criteriaResults, intentVersions, runs } from "../db/schema.ts";
import { resetWithDemoShop, testDb } from "../db/test-db.ts";
import { advance } from "../runs/advance.ts";
import type { Fact } from "../runs/transition.ts";
import { readingsLine, reportModel } from "./model.ts";

const FIXTURES = new URL("../../../../fixtures/criteria/", import.meta.url);
const criteria = ["C1", "C2"].map((id) =>
  JSON.parse(readFileSync(new URL(`${id}.json`, FIXTURES), "utf8")),
);
const INTENT = { criteria, intentSource: "linked_issue", ticketHash: "a".repeat(64) };
const BASE = "https://intenzo-cloud.vercel.app";
const T0 = Date.parse("2026-10-31T09:00:00.000Z");
const RUN_1 = "00000000-0000-4000-8000-000000000001";
const RUN_2 = "00000000-0000-4000-8000-000000000002";

let t: Awaited<ReturnType<typeof testDb>>;
let groupId: number;
let ids: number;

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  const repo = await resetWithDemoShop(t.db);
  groupId = (await ensureRunGroup(t.db, repo.id, 7)).id;
  ids = 0;
});

const happen = (fact: Fact, minute = 0) =>
  advance(t.db, groupId, fact, {
    now: new Date(T0 + minute * 60_000),
    newRunId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });

/** A PR lane as the worker reports it: the trigger at T0+10 s, the human video offset by −T0. */
const prLane = {
  criterionId: "C2",
  side: "pr",
  status: "completed",
  laneStartMs: T0,
  tTriggerMs: T0 + 10_000,
  humanVideo: {
    store: "private",
    path: `runs/${RUN_2}/C2/pr/take-1/human.mp4`,
    contentType: "video/mp4",
  },
  videoOffsets: { human: -T0, judge: -T0 },
  readings: [
    {
      i: 0,
      label: "order total",
      kind: "text",
      phase: "pre",
      tMs: T0 + 9_000,
      value: "$50.00",
      bbox: null,
    },
    {
      i: 1,
      label: "order total",
      kind: "text",
      phase: "post",
      tMs: T0 + 10_000,
      value: "$50.00",
      bbox: null,
    },
    {
      i: 2,
      label: "order total",
      kind: "text",
      phase: "post",
      tMs: T0 + 11_000,
      value: "$50.00",
      bbox: null,
    },
    {
      i: 3,
      label: "order total",
      kind: "text",
      phase: "after_reload",
      tMs: T0 + 15_000,
      value: "$45.00",
      bbox: null,
    },
  ],
};

describe("reportModel", () => {
  it("shows the latest run that wasn't superseded, its criteria, verdicts, clips and readings", async () => {
    await happen({ kind: "pr_ready", trigger: "opened", headSha: "af1065e", draft: false });
    await happen({ kind: "pr_pushed", headSha: "40028b4", draft: false }, 1);
    await happen(
      { kind: "preview_ready", sha: "40028b4", url: "https://demo-shop-x.vercel.app" },
      2,
    );
    const [intent] = await t.db
      .insert(intentVersions)
      .values({ runGroupId: groupId, ticketHash: INTENT.ticketHash, intentJson: INTENT })
      .returning();
    await t.db
      .update(runs)
      .set({
        intentVersionId: intent!.id,
        baseSha: "b6b60c7dde",
        baseDrift: 0,
        baseUrl: "https://main",
      })
      .where(eq(runs.id, RUN_2));
    await t.db.insert(criteriaResults).values([
      {
        runId: RUN_2,
        criterionId: "C2",
        verdict: "fail",
        reasonCode: "agreed",
        judgesJson: [{ model: "stub" }, { model: "stub" }],
        lanesJson: [prLane],
        evidenceJson: {
          window: { startMs: T0 + 9_000, endMs: T0 + 13_000 },
          observed: "It stayed $50.00.",
        },
      },
    ]);

    const model = (await reportModel(t.db, groupId, BASE))!;
    expect(model.run).toMatchObject({
      id: RUN_2,
      headSha: "40028b4",
      state: "verifying",
      baseline: { sha: "b6b60c7dde", drift: 0 },
      judges: ["stub"],
    });
    expect(model.criteria).toEqual([
      expect.objectContaining({ id: "C1", verdict: null, clip: null }),
      expect.objectContaining({
        id: "C2",
        verdict: "fail",
        observed: "It stayed $50.00.",
        // §21.4: file ms = canonical ms + the offset.
        clip: { startMs: 9_000, endMs: 13_000 },
        readings: "+0 s $50.00 · +1 s $50.00 · after reload $45.00",
      }),
    ]);
    expect(model.reportUrl).toBe(`${BASE}/r/${RUN_2}`);
    expect(model.history).toEqual([{ headSha: "af1065e", attemptNo: 1, outcome: "superseded" }]);
    expect(model.policy).toEqual({ inconclusive: "neutral", agentHandle: null });
  });

  it("describes a given run, so a superseded run's check run keeps saying so", async () => {
    await happen({ kind: "pr_ready", trigger: "opened", headSha: "af1065e", draft: false });
    await happen({ kind: "pr_pushed", headSha: "40028b4", draft: false }, 1);
    expect((await reportModel(t.db, groupId, BASE, RUN_1))!.run).toMatchObject({
      id: RUN_1,
      outcome: "superseded",
    });
    expect((await reportModel(t.db, groupId, BASE))!.run.id).toBe(RUN_2);
  });

  it("is null for a group without runs", async () => {
    expect(await reportModel(t.db, groupId, BASE)).toBeNull();
  });
});

describe("readingsLine", () => {
  it("keeps what happened after the trigger, timed from it", () => {
    expect(readingsLine(prLane as never)).toBe("+0 s $50.00 · +1 s $50.00 · after reload $45.00");
  });
});
