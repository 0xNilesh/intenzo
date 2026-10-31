import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { decide } from "../runs/transition.ts";
import { deployments, installations, repos, runGroups, runs } from "./schema.ts";
import { testDb } from "./test-db.ts";

const AT = new Date("2026-10-31T09:00:00.000Z");

let t: Awaited<ReturnType<typeof testDb>>;
let groupId: number;
let repoId: number;

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.db.execute(
    sql`truncate ${runs}, ${runGroups}, ${deployments}, ${repos}, ${installations} restart identity cascade`,
  );
  const [installation] = await t.db
    .insert(installations)
    .values({ ghInstallationId: 177107116, account: "sumithprabhu" })
    .returning();
  const [repo] = await t.db
    .insert(repos)
    .values({
      installationId: installation!.id,
      ghRepoId: 1_087_000_001,
      fullName: "sumithprabhu/demo-shop",
      defaultBranch: "main",
    })
    .returning();
  repoId = repo!.id;
  const [group] = await t.db.insert(runGroups).values({ repoId, prNumber: 6 }).returning();
  groupId = group!.id;
});

/** The Postgres constraint a failed write broke (Drizzle wraps the driver's error). */
async function brokenConstraint(write: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await write;
  } catch (err) {
    const cause = (err as { cause?: { constraint?: string } }).cause;
    return cause?.constraint;
  }
  return undefined;
}

const run = (overrides: Partial<typeof runs.$inferInsert> = {}): typeof runs.$inferInsert => ({
  runGroupId: groupId,
  headSha: "f3cbadc",
  attemptNo: 1,
  trigger: "opened",
  state: "waiting_inputs",
  createdAt: AT,
  ...overrides,
});

describe("the run tables (§11)", () => {
  it("store the state machine's runs field for field", async () => {
    const { created } = decide(
      {
        id: groupId,
        runs: [],
        previews: new Map([["f3cbadc", "https://demo-shop-git-x.vercel.app"]]),
        inconclusiveConclusion: "neutral",
      },
      { kind: "pr_ready", trigger: "opened", headSha: "f3cbadc", draft: false },
      { now: AT, newRunId: () => "8f9b1c2e-6a8f-4f53-9d0c-1b2a3c4d5e6f" },
    );
    await t.db.insert(runs).values(created.map((r) => ({ ...r, runGroupId: groupId })));

    const [row] = await t.db.select().from(runs).where(eq(runs.id, created[0]!.id));
    expect(row).toMatchObject(created[0]!);
  });

  it("number attempts once per commit in a group", async () => {
    await t.db.insert(runs).values(run({ state: "done", outcome: "inconclusive" }));
    expect(await brokenConstraint(t.db.insert(runs).values(run()))).toBe(
      "runs_run_group_id_head_sha_attempt_no_unique",
    );
    await t.db.insert(runs).values(run({ attemptNo: 2 }));
    await t.db.insert(runs).values(run({ headSha: "0a1b2c3" }));
  });

  it.each([
    ["done without an outcome", { state: "done" }, "runs_outcome_when_done"],
    [
      "an outcome before it's done",
      { state: "verifying", outcome: "pass" },
      "runs_outcome_when_done",
    ],
    ["a state outside §16.1", { state: "paused" }, "runs_state"],
  ] as const)("refuse a run %s", async (_name, fields, constraint) => {
    const values = run(fields as Partial<typeof runs.$inferInsert>);
    expect(await brokenConstraint(t.db.insert(runs).values(values))).toBe(constraint);
  });

  it("keep one deployment per repo, commit and environment", async () => {
    const deployment = (environment: string) => ({
      repoId,
      sha: "f3cbadc",
      environment,
      url: "https://demo-shop-abc.vercel.app",
      state: "success",
      ghDeploymentId: 3_400_000_000,
      receivedAt: AT,
    });
    await t.db.insert(deployments).values(deployment("Preview"));
    expect(await brokenConstraint(t.db.insert(deployments).values(deployment("Preview")))).toBe(
      "deployments_repo_id_sha_environment_unique",
    );
    await t.db.insert(deployments).values(deployment("Production"));
  });

  it("keep one run group per pull request", async () => {
    expect(await brokenConstraint(t.db.insert(runGroups).values({ repoId, prNumber: 6 }))).toBe(
      "run_groups_repo_id_pr_number_unique",
    );
  });
});
