import { readFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { deployments, runGroups, runs } from "../db/schema.ts";
import { resetWithDemoShop, testDb } from "../db/test-db.ts";
import { githubClient } from "./api.ts";
import { fakeGitHub, notFound } from "./fake-github.ts";
import { eventHandlers } from "./handlers.ts";

// Real deliveries captured in T0.4 (packages/core/fixtures/github/README.md): PR #2 is opened at
// a412468, pushed to 39eed67, and Vercel deploys 39eed67 as a Preview.
const FIXTURES = new URL("../../../../packages/core/fixtures/", import.meta.url);
type Payload = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fixture = (name: string): { event: string; action: string | null; payload: Payload } =>
  JSON.parse(readFileSync(new URL(`github/${name}.json`, FIXTURES), "utf8"));
const DEMO_SHOP_CONFIG = readFileSync(new URL("config/demo-shop.intenzo.yml", FIXTURES), "utf8");

const REPO = "/repos/sumithprabhu/intenzo-t04-sandbox";
const OPENED_SHA = "a4124687db94bef0fc223cba34479050371f66f1";
const PUSHED_SHA = "39eed67b0ce64a98c3da2f723f7ec61f663d0076";
const MERGE_BASE = "8440e97436555a6b7ccf94b58c5e8d5c536ab38b";
const PR_URL = "https://intenzo-t04-sandbox-hnx4nfyzw-sumithprabhus-projects.vercel.app";
const MAIN_URL = "https://intenzo-t04-sandbox-main0000-sumithprabhus-projects.vercel.app";

const github = fakeGitHub();
let t: Awaited<ReturnType<typeof testDb>>;
let lines: string[];
let ids: number;
let drains: number;

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetWithDemoShop(t.db);
  lines = [];
  ids = 0;
  drains = 0;
});

const handlers = () =>
  eventHandlers({
    db: t.db,
    github: () => githubClient(async () => "ghs_test"),
    now: () => new Date("2026-10-31T09:00:00.000Z"),
    newRunId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    log: (line) => lines.push(line),
    drain: async () => (drains += 1),
  });

async function deliver(name: string, edit: (payload: Payload) => void = () => {}) {
  const { event, action, payload } = fixture(name);
  edit(payload);
  await handlers()[event]!({ id: 1, deliveryId: name, event, action, payload });
}

/** The sandbox repo as GitHub would answer for it: its config, deployments and PRs. */
function sandbox({
  config = DEMO_SHOP_CONFIG,
  previews = {} as Record<string, { id: number; environment: string; url?: string }[]>,
  // Each open PR's head and commits. GitHub lists a commit's PRs by the commits they contain.
  pulls = { 2: { head: PUSHED_SHA, commits: [OPENED_SHA, PUSHED_SHA] } } as Record<
    number,
    { head: string; commits: string[] }
  >,
} = {}) {
  github.get(`${REPO}/contents/.intenzo.yml`, () => new Response(config));
  github.get(`${REPO}/contents/.intenzo.yaml`, notFound);
  github.get(`${REPO}/deployments`, (request: Request) => {
    const sha = new URL(request.url).searchParams.get("sha")!;
    return (previews[sha] ?? []).map(({ id, environment }) => ({ id, sha, environment }));
  });
  for (const list of Object.values(previews)) {
    for (const { id, url } of list) {
      if (url)
        github.get(`${REPO}/deployments/${id}/statuses`, [
          { state: "success", environment_url: url },
        ]);
    }
  }
  github.get(`${REPO}/commits/:sha/pulls`, (request: Request) => {
    const sha = new URL(request.url).pathname.split("/")[5];
    return Object.entries(pulls)
      .filter(([, pr]) => pr.commits.includes(sha!))
      .map(([number, pr]) => ({
        number: Number(number),
        state: "open",
        head: { sha: pr.head },
        base: { ref: "main" },
      }));
  });
  github.get(`${REPO}/compare/main...:head`, {
    merge_base_commit: { sha: MERGE_BASE, parents: [{ sha: "7d1e2f3" }] },
  });
  // The merge base's parent is main's first commit: the drift walk ends there.
  github.get(`${REPO}/commits/7d1e2f3`, { sha: "7d1e2f3", parents: [] });
}

const runsByHead = async () =>
  Object.fromEntries((await t.db.select().from(runs)).map((r) => [r.headSha.slice(0, 7), r]));

describe("pull_request and deployment_status (§16.2, §17)", () => {
  it("verifies the PR's preview with the merge base's preview as its baseline", async () => {
    // main's merge base has a Production and a Preview deployment; only the Preview may be used.
    sandbox({
      previews: {
        [MERGE_BASE]: [
          { id: 21, environment: "Production" },
          { id: 20, environment: "Preview", url: MAIN_URL },
        ],
      },
    });
    await deliver("pull_request.opened");
    await deliver("pull_request.synchronize");
    await deliver("deployment_status.success.preview");

    const byHead = await runsByHead();
    expect(byHead["a412468"]).toMatchObject({ state: "done", outcome: "superseded" });
    expect(byHead["39eed67"]).toMatchObject({
      state: "verifying",
      prUrl: PR_URL,
      baseUrl: MAIN_URL,
      baseSha: MERGE_BASE,
      baseDrift: 0,
    });
    expect(lines).toContain(
      `PR #2: run 00000000: baseline main@8440e97 (the merge base) at ${MAIN_URL}`,
    );
    expect(github.calls.some((call) => call.includes("/deployments/21/"))).toBe(false);
    // Each event that changed a run drained the outbox it wrote to.
    expect(drains).toBe(3);
  });

  it("never starts a run from a production deployment of its head", async () => {
    sandbox();
    await deliver("pull_request.opened");
    await deliver("deployment_status.success.production", (p) => {
      p.deployment.sha = OPENED_SHA;
    });
    expect(await runsByHead()).toMatchObject({ a412468: { state: "waiting_inputs" } });
    expect(await t.db.select().from(deployments)).toMatchObject([
      { sha: OPENED_SHA, environment: "Production" },
    ]);
    expect(lines.at(-1)).toBe(
      "deployment of a412468 (Production, success): stored; not a preview environment",
    );
    expect(github.calls.some((call) => call.endsWith("/pulls"))).toBe(false);
    expect(drains).toBe(1);
  });

  it("stores a preview of a commit in no open PR, and changes nothing", async () => {
    sandbox({ pulls: { 2: { head: OPENED_SHA, commits: [OPENED_SHA] } } });
    await deliver("pull_request.opened");
    await deliver("deployment_status.success.preview");
    expect(await runsByHead()).toMatchObject({ a412468: { state: "waiting_inputs" } });
    expect(await t.db.select().from(deployments)).toMatchObject([{ sha: PUSHED_SHA, url: PR_URL }]);
    expect(lines.at(-1)).toBe(
      "deployment of 39eed67 (Preview, success): stored; no open PR has it as its head",
    );
  });

  it("doesn't start a run for a commit its PR has already moved past", async () => {
    // The push to 39eed67 is on GitHub, but its synchronize event hasn't been handled yet.
    sandbox();
    await deliver("pull_request.opened");
    await deliver("deployment_status.success.preview", (p) => {
      p.deployment.sha = OPENED_SHA;
    });
    expect(await runsByHead()).toMatchObject({ a412468: { state: "waiting_inputs" } });
    expect(lines.at(-1)).toBe(
      "deployment of a412468 (Preview, success): stored; no open PR has it as its head",
    );
  });

  it("goes on without a baseline when the base branch has no preview within reach", async () => {
    sandbox({ config: "version: 1\nbaseline: { max_drift_commits: 0 }\n" });
    await deliver("pull_request.synchronize");
    await deliver("deployment_status.success.preview");
    expect(await runsByHead()).toMatchObject({
      "39eed67": {
        state: "verifying",
        prUrl: PR_URL,
        baseUrl: null,
        baseSha: null,
        baseDrift: null,
      },
    });
    expect(lines).toContain(
      "PR #2: run 00000000: baseline none (no preview of main@8440e97 or the commits before it)",
    );
  });

  it("finds a draft's preview by lookup once the PR is ready for review", async () => {
    sandbox();
    await deliver("pull_request.opened", (p) => {
      p.pull_request.draft = true;
      p.pull_request.head.sha = PUSHED_SHA;
    });
    await deliver("deployment_status.success.preview");
    expect(await runsByHead()).toEqual({});

    await deliver("pull_request.opened", (p) => {
      p.action = "ready_for_review";
      p.pull_request.head.sha = PUSHED_SHA;
    });
    expect(await runsByHead()).toMatchObject({
      "39eed67": { trigger: "ready_for_review", state: "verifying", prUrl: PR_URL, baseUrl: null },
    });
    expect(lines).toContain(
      "PR #2: run 00000000: baseline none (no preview of main@8440e97 or the commits before it)",
    );
  });

  it("verifies nothing while .intenzo.yml has problems, and says which", async () => {
    sandbox({ config: "version: 1\npolicy: { auto_merge: true }\n" });
    await deliver("pull_request.opened");
    expect(await t.db.select().from(runGroups)).toEqual([]);
    expect(lines).toEqual([
      "PR #2: not verified, the config has problems: .intenzo.yml:2: policy.auto_merge: unknown key",
    ]);
  });

  // §29: a fork's PR never gets the repo's secrets, so its group remembers where it came from.
  it.each([
    ["a branch of the repo", false, () => {}],
    ["a fork", true, (p: Payload) => void (p.pull_request.head.repo.id = 4242)],
    ["a fork that was deleted", true, (p: Payload) => void (p.pull_request.head.repo = null)],
  ])("remembers that a PR from %s is from_fork %s", async (_from, fromFork, edit) => {
    sandbox();
    await deliver("pull_request.opened", edit);
    expect((await t.db.select().from(runGroups)).map((g) => g.fromFork)).toEqual([fromFork]);
  });
});
