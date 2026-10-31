import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureRunGroup } from "../db/repos.ts";
import { criteriaResults, intentVersions, runs } from "../db/schema.ts";
import { resetWithDemoShop, testDb } from "../db/test-db.ts";
import { advance } from "../runs/advance.ts";
import { reportPage } from "./page-data.ts";

const FIXTURES = new URL("../../../../fixtures/criteria/", import.meta.url);
const criteria = ["C1", "C2"].map((id) =>
  JSON.parse(readFileSync(new URL(`${id}.json`, FIXTURES), "utf8")),
);
const RUN = "00000000-0000-4000-8000-000000000001";
const BASE = "https://intenzo-cloud.vercel.app";
const video = (side: string) => ({
  store: "private",
  path: `runs/${RUN}/C2/${side}/take-1/human.mp4`,
  contentType: "video/mp4",
});

let t: Awaited<ReturnType<typeof testDb>>;

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  const repo = await resetWithDemoShop(t.db);
  const groupId = (await ensureRunGroup(t.db, repo.id, 7)).id;
  await advance(
    t.db,
    groupId,
    { kind: "pr_ready", trigger: "opened", headSha: "40028b4", draft: false },
    { now: new Date(), newRunId: () => RUN },
  );
  const [intent] = await t.db
    .insert(intentVersions)
    .values({
      runGroupId: groupId,
      ticketHash: "c".repeat(64),
      intentJson: { criteria, intentSource: "linked_issue", ticketHash: "c".repeat(64) },
    })
    .returning();
  await t.db.update(runs).set({ intentVersionId: intent!.id }).where(eq(runs.id, RUN));
  await t.db.insert(criteriaResults).values({
    runId: RUN,
    criterionId: "C2",
    verdict: "fail",
    reasonCode: "agreed",
    lanesJson: [
      { criterionId: "C2", side: "pr", humanVideo: video("pr") },
      { criterionId: "C2", side: "base", humanVideo: video("base") },
    ],
  });
});

const signed = async (ref: { path: string }) => `https://private.example/${ref.path}?signed`;

describe("reportPage", () => {
  it("gives each criterion's recorded sides a playable URL", async () => {
    const page = (await reportPage(t.db, RUN, signed, BASE))!;
    expect(page.model.run.id).toBe(RUN);
    expect(page.model.criteria.map((c) => c.id)).toEqual(["C1", "C2"]);
    expect(page.videos).toEqual({
      C2: {
        pr: `https://private.example/runs/${RUN}/C2/pr/take-1/human.mp4?signed`,
        base: `https://private.example/runs/${RUN}/C2/base/take-1/human.mp4?signed`,
      },
    });
  });

  it.each(["not-a-uuid", "00000000-0000-4000-8000-00000000ffff", "../../etc"])(
    "is null for %s",
    async (runId) => {
      expect(await reportPage(t.db, runId, signed, BASE)).toBeNull();
    },
  );
});
