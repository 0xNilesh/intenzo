import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureRunGroup } from "../db/repos.ts";
import { outbox, runGroups, runs } from "../db/schema.ts";
import { resetWithDemoShop, testDb } from "../db/test-db.ts";
import { githubClient } from "../github/api.ts";
import { fakeGitHub, json, notFound } from "../github/fake-github.ts";
import { advance } from "../runs/advance.ts";
import type { Fact } from "../runs/transition.ts";
import { drainOutbox } from "./drain.ts";
import { githubExecutors } from "./github-effects.ts";

const REPO = "/repos/sumithprabhu/demo-shop";
const T0 = Date.parse("2026-10-31T09:00:00.000Z");
const RUN_1 = "00000000-0000-4000-8000-000000000001";
const RUN_2 = "00000000-0000-4000-8000-000000000002";
const PREVIEW = "https://demo-shop-60b7pwtbw-sumithprabhus-projects.vercel.app";

const github = fakeGitHub();
let t: Awaited<ReturnType<typeof testDb>>;
let groupId: number;
let ids: number;
let sent: { call: string; body: Record<string, any> }[]; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  const repo = await resetWithDemoShop(t.db);
  groupId = (await ensureRunGroup(t.db, repo.id, 7)).id;
  ids = 0;
  sent = [];
});

const opened: Fact = { kind: "pr_ready", trigger: "opened", headSha: "b4e35b0", draft: false };
const happen = (fact: Fact, minute = 0) =>
  advance(t.db, groupId, fact, {
    now: new Date(T0 + minute * 60_000),
    newRunId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
const drain = () =>
  drainOutbox({
    db: t.db,
    executors: githubExecutors({ db: t.db, github: () => githubClient(async () => "ghs_test") }),
    now: () => new Date(T0),
    log: () => {},
  });

/**
 * GitHub with no check run or comment yet, unless given: records each POST and PATCH Intenzo sends
 * ("PATCH comment/12") and answers with an id, a new one for each POST.
 */
function freshPr({ checkRuns = [] as object[], comments = [] as object[] } = {}) {
  let next = 9000;
  const record = (kind: string) => async (request: Request) => {
    const id = Number(new URL(request.url).pathname.split("/").at(-1));
    const patched = request.method === "PATCH";
    sent.push({
      call: patched ? `PATCH ${kind}/${id}` : `POST ${kind}`,
      body: await request.json(),
    });
    return json({ id: patched ? id : ++next }, patched ? 200 : 201);
  };
  github.get(`${REPO}/commits/:sha/check-runs`, { total_count: 0, check_runs: checkRuns });
  github.post(`${REPO}/check-runs`, record("check-runs"));
  github.patch(`${REPO}/check-runs/:id`, record("check-runs"));
  github.get(`${REPO}/issues/7/comments`, comments);
  github.post(`${REPO}/issues/7/comments`, record("comment"));
  github.patch(`${REPO}/issues/comments/:id`, record("comment"));
}
const calls = () => sent.map((s) => s.call);
const [runRow, groupRow] = [
  async (id: string) => (await t.db.select().from(runs).where(eq(runs.id, id)))[0]!,
  async () => (await t.db.select().from(runGroups).where(eq(runGroups.id, groupId)))[0]!,
];

describe("the Intenzo check run (§26.2)", () => {
  it("is created for the run with its id as external_id, then updated as the run moves on", async () => {
    freshPr();
    await happen(opened);
    await drain();
    expect(sent[0]).toEqual({
      call: "POST check-runs",
      body: {
        name: "Intenzo",
        head_sha: "b4e35b0",
        external_id: RUN_1,
        status: "queued",
        output: {
          title: "Waiting for the preview",
          summary: "⏳ Waiting for the preview of `b4e35b0`.",
        },
      },
    });
    expect((await runRow(RUN_1)).checkRunId).toBe(9001);

    await happen({ kind: "preview_ready", sha: "b4e35b0", url: PREVIEW }, 2);
    await drain();
    expect(sent.find((s) => s.call === "PATCH check-runs/9001")?.body).toMatchObject({
      status: "in_progress",
      started_at: new Date(T0 + 2 * 60_000).toISOString(),
      output: { title: "Verifying the preview" },
    });
  });

  it("reuses the check run a drainer that died had created, found by its external_id", async () => {
    freshPr({ checkRuns: [{ id: 4242, external_id: RUN_1 }] });
    await happen(opened);
    await drain();
    expect(calls().filter((c) => c.includes("check-runs"))).toEqual(["PATCH check-runs/4242"]);
    expect((await runRow(RUN_1)).checkRunId).toBe(4242);
  });

  it("closes a superseded run's check run as neutral and opens one for the new commit", async () => {
    freshPr();
    await happen(opened);
    await drain();
    await happen({ kind: "pr_pushed", headSha: "c5f46c1", draft: false }, 3);
    await drain();
    expect(sent.find((s) => s.call === "PATCH check-runs/9001")?.body).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      output: { title: "Superseded" },
    });
    expect(sent.filter((s) => s.call === "POST check-runs").map((s) => s.body.external_id)).toEqual(
      [RUN_1, RUN_2],
    );
  });
});

describe("the run group's comment (§26.1)", () => {
  it("is posted once and edited from then on", async () => {
    freshPr();
    await happen(opened);
    await drain();
    const posted = sent.find((s) => s.call === "POST comment")!;
    expect(posted.body.body).toBe(
      `<!-- intenzo:run-group:${groupId} -->\n### Intenzo\n\n⏳ Waiting for the preview of \`b4e35b0\`.\n`,
    );
    const commentId = (await groupRow()).commentId!;

    await happen({ kind: "preview_ready", sha: "b4e35b0", url: PREVIEW }, 2);
    await drain();
    expect(calls().filter((c) => c.includes("comment"))).toEqual([
      "POST comment",
      `PATCH comment/${commentId}`,
    ]);
    expect(sent.at(-1)?.body.body).toContain(
      `🔎 Verifying \`b4e35b0\` on [its preview](${PREVIEW})`,
    );
  });

  it("skips an older comment effect when a newer one is pending (§16.4)", async () => {
    freshPr();
    await happen(opened);
    await happen({ kind: "preview_ready", sha: "b4e35b0", url: PREVIEW }, 2);
    await drain();
    expect(calls().filter((c) => c.includes("comment"))).toEqual(["POST comment"]);
    expect(sent.find((s) => s.call === "POST comment")?.body.body).toContain("🔎 Verifying");
    const comments = await t.db.select().from(outbox).where(eq(outbox.effect, "comment"));
    expect(comments.map((c) => c.status)).toEqual(["done", "done"]);
  });

  it("finds its own comment by the marker when the id wasn't saved, never a human's quote", async () => {
    const marker = `<!-- intenzo:run-group:${groupId} -->`;
    freshPr({
      comments: [
        { id: 11, user: { type: "User" }, body: `${marker}\n> quoted` },
        { id: 12, user: { type: "Bot" }, body: `${marker}\n### Intenzo` },
      ],
    });
    await happen(opened);
    await drain();
    expect(calls().filter((c) => c.includes("comment"))).toEqual(["PATCH comment/12"]);
  });

  it("posts a new comment when someone deleted it", async () => {
    freshPr();
    await t.db.update(runGroups).set({ commentId: 77 }).where(eq(runGroups.id, groupId));
    github.patch(`${REPO}/issues/comments/77`, notFound);
    await happen(opened);
    await drain();
    expect(calls().filter((c) => c.includes("comment"))).toEqual(["POST comment"]);
    expect((await groupRow()).commentId).toBe(9001 + 1);
  });
});
