import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { IntenzoConfig } from "@intenzo/core";

import { ensureRunGroup, saveConfig } from "../db/repos.ts";
import { outbox } from "../db/schema.ts";
import { resetWithDemoShop, testDb } from "../db/test-db.ts";
import { githubClient } from "../github/api.ts";
import { fakeGitHub, json, notFound } from "../github/fake-github.ts";
import { eventHandlers } from "../github/handlers.ts";
import { drainOutbox } from "../outbox/drain.ts";
import { approvalExecutors } from "../outbox/approval-effects.ts";
import { githubExecutors } from "../outbox/github-effects.ts";
import { advance } from "../runs/advance.ts";
import type { Fact } from "../runs/transition.ts";
import { isListedApprover } from "./approve.ts";

const REPO = "/repos/sumithprabhu/demo-shop";
const T0 = Date.parse("2026-11-01T09:00:00.000Z");
const BASE = "https://intenzo-cloud.vercel.app";
const runId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SHA = "a".repeat(40);

const github = fakeGitHub();
let t: Awaited<ReturnType<typeof testDb>>;
let groupId: number;
let ids: number;
let deliveries: number;
let lines: string[];
let sent: { call: string; body: Record<string, any> }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
/** Each login's permission on the repo, as GitHub answers; absent means a 404. */
let permissions: Record<string, string>;

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  const repo = await resetWithDemoShop(t.db);
  await saveConfig(
    t.db,
    repo.id,
    IntenzoConfig.parse({ version: 1, policy: { approvers: ["sumithprabhu", "@PM-Person"] } }),
  );
  groupId = (await ensureRunGroup(t.db, repo.id, 7)).id;
  ids = 0;
  deliveries = 0;
  lines = [];
  sent = [];
  permissions = {
    sumithprabhu: "admin",
    "pm-person": "write",
    "a-teammate": "write",
    reader: "read",
  };
  let next = 9000;
  const record = (kind: string) => async (request: Request) => {
    const patched = request.method === "PATCH";
    const id = patched ? Number(new URL(request.url).pathname.split("/").at(-1)) : ++next;
    sent.push({
      call: `${request.method} ${kind}`,
      body: (await request.json()) as Record<string, unknown>,
    });
    return json({ id }, patched ? 200 : 201);
  };
  github.get(`${REPO}/commits/:sha/check-runs`, { total_count: 0, check_runs: [] });
  github.post(`${REPO}/check-runs`, record("check-runs"));
  github.patch(`${REPO}/check-runs/:id`, record("check-runs"));
  github.get(`${REPO}/issues/7/comments`, []);
  github.post(`${REPO}/issues/7/comments`, record("comment"));
  github.patch(`${REPO}/issues/comments/:id`, record("comment"));
  github.post(`${REPO}/statuses/:sha`, record("status"));
  github.get(`${REPO}/collaborators/:login/permission`, (request: Request) => {
    const login = decodeURIComponent(new URL(request.url).pathname.split("/")[5]!).toLowerCase();
    const permission = permissions[login];
    return permission ? json({ permission, role_name: permission }) : notFound();
  });
});

const happen = (fact: Fact, minute = 0) =>
  advance(t.db, groupId, fact, {
    now: new Date(T0 + minute * 60_000),
    newRunId: () => runId(++ids),
  });

const drain = () =>
  drainOutbox({
    db: t.db,
    executors: {
      ...approvalExecutors({
        db: t.db,
        github: () => githubClient(async () => "ghs_test"),
        reportBaseUrl: BASE,
      }),
      ...githubExecutors({
        db: t.db,
        github: () => githubClient(async () => "ghs_test"),
        reportBaseUrl: BASE,
      }),
    },
    now: () => new Date(T0 + 60 * 60_000),
    log: (line) => lines.push(line),
  });

const handlers = () =>
  eventHandlers({
    db: t.db,
    github: () => githubClient(async () => "ghs_test"),
    now: () => new Date(T0),
    newRunId: () => runId(++ids),
    log: (line) => lines.push(line),
    drain: () => drain(),
  });

const repoPayload = {
  installation: { id: 177107116 },
  repository: {
    id: 1_087_000_001,
    full_name: "sumithprabhu/demo-shop",
    default_branch: "main",
    owner: { login: "sumithprabhu" },
  },
};

/** Approve (PM) pressed on a run's check run (§26.2). */
const press = (run: string, login: string) =>
  handlers().check_run!({
    id: ++deliveries,
    deliveryId: `delivery-${deliveries}`,
    event: "check_run",
    action: "requested_action",
    payload: {
      ...repoPayload,
      action: "requested_action",
      check_run: { external_id: run },
      requested_action: { identifier: "approve" },
      sender: { login },
    },
  });

/** A comment on PR #7. */
const comment = (body: string, login: string, type = "User") =>
  handlers().issue_comment!({
    id: ++deliveries,
    deliveryId: `delivery-${deliveries}`,
    event: "issue_comment",
    action: "created",
    payload: {
      ...repoPayload,
      action: "created",
      issue: { number: 7, pull_request: { url: "…" } },
      comment: { body, user: { login, type } },
    },
  });

/** PR #7's run at SHA, finished by its job. */
async function finished(outcome: "pass" | "fail") {
  await happen({ kind: "pr_ready", trigger: "opened", headSha: SHA, draft: false });
  await happen({ kind: "preview_ready", sha: SHA, url: "https://shop-preview.vercel.app" }, 1);
  await happen({ kind: "job_finished", runId: runId(1), outcome }, 3);
  await drain();
  sent = [];
  return runId(1);
}

const statuses = () => sent.filter((s) => s.call === "POST status").map((s) => s.body);
const replies = () =>
  sent.filter((s) => s.call === "POST comment").map((s) => s.body.body as string);
const report = () => sent.filter((s) => s.call === "PATCH comment").at(-1)?.body.body as string;

describe("PM approval (§26.2)", () => {
  it("lets a listed approver with write access approve a passing run: a status names them", async () => {
    const run = await finished("pass");
    await press(run, "sumithprabhu");
    expect(statuses()).toEqual([
      {
        state: "success",
        context: "Intenzo / product approval",
        description: "Approved by sumithprabhu",
        target_url: `${BASE}/r/${run}`,
      },
    ]);
    expect(lines.at(-1)).toBe(
      `run ${run.slice(0, 8)}: sumithprabhu pressed Approve (PM): approved`,
    );
    // The comment and the run's check run show it.
    expect(report()).toContain("👍 Product approval: `sumithprabhu`");
    expect(sent.find((s) => s.call === "PATCH check-runs")?.body.output.summary).toContain(
      "👍 Product approval: `sumithprabhu`",
    );
    expect(replies()).toEqual([]);
  });

  it("answers someone who isn't an approver, or has no write access, and approves nothing", async () => {
    const run = await finished("pass");
    await press(run, "a-teammate");
    await press(run, "reader");
    permissions = { ...permissions, "pm-person": "read" };
    await press(run, "PM-Person");
    expect(statuses()).toEqual([]);
    expect(replies()).toEqual([
      "@a-teammate isn't an approver for this repo (`policy.approvers` in `.intenzo.yml`).",
      "@reader isn't an approver for this repo (`policy.approvers` in `.intenzo.yml`).",
      "@PM-Person isn't an approver for this repo: approving needs write access.",
    ]);
  });

  it("takes /intenzo approve in a comment, the same way, and says when there's nothing to approve", async () => {
    const run = await finished("pass");
    await comment("Looks right to me.\n/intenzo approve", "PM-Person");
    expect(statuses().map((s) => s.description)).toEqual(["Approved by PM-Person"]);
    expect(lines.at(-1)).toBe("PR #7: PM-Person wrote /intenzo approve: approved");
    // Bots and comments without the command are ignored.
    await comment("/intenzo approve", "intenzo-ai[bot]", "Bot");
    await comment("please /intenzo approve this", "sumithprabhu");
    expect(statuses()).toHaveLength(1);
    expect(
      (await t.db.select().from(outbox).where(eq(outbox.effect, "approval"))).map((r) => r.runId),
    ).toEqual([run]);
  });

  it("never approves a failed run: a stale press is only logged, a command is answered", async () => {
    const run = await finished("fail");
    await press(run, "sumithprabhu");
    expect(lines.at(-1)).toContain("Approve (PM): refused, the run didn't pass");
    await comment("/intenzo approve", "sumithprabhu");
    expect(statuses()).toEqual([]);
    expect(replies()).toEqual([
      "@sumithprabhu there's nothing to approve yet: Intenzo's latest run on this pull request hasn't passed.",
    ]);
  });

  it("matches approvers as GitHub matches logins: with or without @, in any case", () => {
    expect(isListedApprover(["@PM-Person"], "pm-person")).toBe(true);
    expect(isListedApprover(["sumithprabhu"], "SumithPrabhu")).toBe(true);
    expect(isListedApprover(["sumithprabhu"], "sumith")).toBe(false);
    expect(isListedApprover([], "sumithprabhu")).toBe(false);
  });
});
