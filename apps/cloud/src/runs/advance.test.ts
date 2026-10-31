import { IntenzoConfig } from "@intenzo/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureRunGroup, type Repo, saveConfig } from "../db/repos.ts";
import { runs } from "../db/schema.ts";
import { resetWithDemoShop, testDb } from "../db/test-db.ts";
import { recordDeployment } from "../deployments/store.ts";
import { advance } from "./advance.ts";
import type { Fact } from "./transition.ts";

const AT = Date.parse("2026-10-31T09:00:00.000Z");
const A = "2be4341844f9a3c1";
const B = "4c64ff0ce7c3b2d0";
const URL_A = "https://demo-shop-l6q1la1nv-sumithprabhus-projects.vercel.app";

let t: Awaited<ReturnType<typeof testDb>>;
let repo: Repo;
let groupId: number;
let ids = 0;

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  repo = await resetWithDemoShop(t.db);
  groupId = (await ensureRunGroup(t.db, repo.id, 7)).id;
});

const at = (minute: number) => ({
  now: new Date(AT + minute * 60_000),
  newRunId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
});
const opened = (headSha: string): Fact => ({
  kind: "pr_ready",
  trigger: "opened",
  headSha,
  draft: false,
});
const deployed = (sha: string, environment = "Preview", url = URL_A) =>
  recordDeployment(t.db, {
    repoId: repo.id,
    sha,
    environment,
    url,
    state: "success",
    ghDeploymentId: 7_454_381_604,
    receivedAt: new Date(AT),
  });
const stored = () => t.db.select().from(runs).where(eq(runs.runGroupId, groupId));

describe("advance (§16.4)", () => {
  it("writes a new run that waits for its preview", async () => {
    const decision = await advance(t.db, groupId, opened(A), at(0));
    expect(decision.effects.map((e) => e.kind)).toEqual(["check_run", "comment"]);
    expect(await stored()).toMatchObject([
      { headSha: A, attemptNo: 1, trigger: "opened", state: "waiting_inputs", prUrl: null },
    ]);
  });

  it("starts the run at once when a usable preview is stored, never a production one", async () => {
    await deployed(A, "Production");
    await advance(t.db, groupId, opened(A), at(0));
    expect(await stored()).toMatchObject([{ state: "waiting_inputs" }]);

    await deployed(A);
    await advance(t.db, groupId, { kind: "preview_ready", sha: A, url: URL_A }, at(2));
    expect(await stored()).toMatchObject([
      { state: "verifying", prUrl: URL_A, startedAt: at(2).now, deadlineAt: at(17).now },
    ]);
  });

  it("writes every run decide() changes: a push supersedes the run before it", async () => {
    await advance(t.db, groupId, opened(A), at(0));
    await advance(t.db, groupId, { kind: "pr_pushed", headSha: B, draft: false }, at(3));
    const rows = await stored();
    expect(rows.find((r) => r.headSha === A)).toMatchObject({
      state: "done",
      outcome: "superseded",
      finishedAt: at(3).now,
    });
    expect(rows.find((r) => r.headSha === B)).toMatchObject({ state: "waiting_inputs" });
  });

  it("follows the repo's config: its environment prefix and its inconclusive policy", async () => {
    const config = IntenzoConfig.parse({
      version: 1,
      preview: { environment_prefix: "Staging" },
      policy: { inconclusive_conclusion: "failure" },
    });
    repo = await saveConfig(t.db, repo.id, config);
    await deployed(A, "Preview");
    await advance(t.db, groupId, opened(A), at(0));
    const timedOut = await advance(t.db, groupId, { kind: "tick" }, at(20));
    expect(timedOut.effects).toContainEqual(expect.objectContaining({ conclusion: "failure" }));

    await deployed(B, "Staging – demo-shop");
    await advance(t.db, groupId, { kind: "pr_pushed", headSha: B, draft: false }, at(21));
    expect((await stored()).find((r) => r.headSha === B)).toMatchObject({ state: "verifying" });
  });
});
