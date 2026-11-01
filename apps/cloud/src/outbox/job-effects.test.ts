import { randomBytes } from "node:crypto";

import { IntenzoConfig, VerifyJob } from "@intenzo/core";
import { asc, eq } from "drizzle-orm";
import { http } from "msw/http";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureRunGroup } from "../db/repos.ts";
import { intentVersions, outbox, repos, runGroups, runs, savedPaths } from "../db/schema.ts";
import { resetWithDemoShop, testDb } from "../db/test-db.ts";
import type { ModalSettings } from "../env.ts";
import { isCurrentJob } from "../jobs/worker-api.ts";
import { verifyJobToken } from "../jobs/token.ts";
import { advance } from "../runs/advance.ts";
import type { Fact } from "../runs/transition.ts";
import { setRepoSecrets } from "../secrets/repo-secrets.ts";
import { drainOutbox } from "./drain.ts";
import { jobExecutors, spawnExecutor } from "./job-effects.ts";

const MODAL: ModalSettings = {
  spawnUrl: "https://sumithprabhu--intenzo-worker-spawn.modal.run",
  cancelUrl: "https://sumithprabhu--intenzo-worker-cancel.modal.run",
  secret: "a-modal-endpoint-secret-for-tests-01234",
  cloudUrl: "https://intenzo-cloud.vercel.app",
};
const JOB_SECRET = "a-job-secret-for-tests-only-0123456789";
const T0 = new Date("2026-10-31T09:00:00.000Z");
const RUN = "00000000-0000-4000-8000-000000000001";
const SECRETS_KEY = randomBytes(32);
const HOOK = "hook-secret-for-the-test-0123456789";
const BYPASS = "bypass-for-the-test-abcdefghijklmnop";
const BASE_SHA = "b6b60c7dde0123456789abcdef0123456789abcd";

// Modal's two endpoints, faked: each request is recorded; one nothing answers fails the test.
const modal = setupServer();
const unanswered: string[] = [];
let calls: { endpoint: string; auth: string | null; body: any }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
beforeAll(() =>
  modal.listen({
    onUnhandledFrame({ frame, defaults }) {
      unanswered.push(String((frame.data as { request?: Request }).request?.url));
      defaults.error();
    },
  }),
);
afterEach(() => {
  modal.resetHandlers();
  const missed = unanswered.splice(0);
  if (missed.length > 0) throw new Error(`nothing answered ${missed.join(", ")}`);
});
afterAll(() => modal.close());

let t: Awaited<ReturnType<typeof testDb>>;
let repoId: number;
let groupId: number;
let ids: number;
let jobIds: number;

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  const repo = await resetWithDemoShop(t.db);
  repoId = repo.id;
  groupId = (await ensureRunGroup(t.db, repo.id, 7, false)).id;
  ids = 0;
  jobIds = 0;
  calls = [];
  const record =
    (endpoint: string, answer: object) =>
    async ({ request }: { request: Request }) => {
      calls.push({
        endpoint,
        auth: request.headers.get("authorization"),
        body: await request.json(),
      });
      return Response.json(answer);
    };
  modal.use(
    http.post(MODAL.spawnUrl, record("spawn", { callId: "fc-01" })),
    http.post(MODAL.cancelUrl, record("cancel", { cancelled: "fc-01" })),
  );
  await happen({ kind: "pr_ready", trigger: "opened", headSha: "b4e35b0", draft: false });
  await happen({ kind: "preview_ready", sha: "b4e35b0", url: "https://demo-shop-x.vercel.app" });
});

const happen = (fact: Fact) =>
  advance(t.db, groupId, fact, {
    now: T0,
    newRunId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
const deps = (secretsKey: Buffer | null = SECRETS_KEY) => ({
  db: t.db,
  modal: MODAL,
  jobSecret: JOB_SECRET,
  secretsKey,
  newJobId: () => `0b0b0b0b-0000-4000-8000-${String(++jobIds).padStart(12, "0")}`,
  now: () => T0,
});
const drain = (secretsKey?: Buffer | null) =>
  drainOutbox({
    db: t.db,
    executors: jobExecutors(deps(secretsKey)),
    now: () => T0,
    log: () => {},
  });
const run = async () => (await t.db.select().from(runs).where(eq(runs.id, RUN)))[0]!;

describe("the spawn effect's context bundle (§8, T4.8)", () => {
  const HASH = "c".repeat(64);
  const CRITERIA = ["C1"].map((id) => ({
    id,
    text: "SAVE10 adds a discount line",
    trigger: "apply SAVE10",
    setup: [],
    expected: "a SAVE10 −$5.00 line",
    watch: ["discount line"],
    kind: "ui_behavior",
    persistence: false,
    inferred: false,
  }));
  const drainWith = (
    bundle: NonNullable<Parameters<typeof jobExecutors>[0]["bundle"]>,
    lines: string[] = [],
  ) =>
    drainOutbox({
      db: t.db,
      executors: jobExecutors({ ...deps(), bundle, log: (l) => lines.push(l) }),
      now: () => T0,
      log: () => {},
    });

  it("sends the bundle's signed URL, and the intent an earlier run read from the same ticket", async () => {
    await t.db.insert(intentVersions).values({
      runGroupId: groupId,
      ticketHash: HASH,
      intentJson: { criteria: CRITERIA, intentSource: "linked_issue_video", ticketHash: HASH },
    });
    const asked: unknown[] = [];
    await drainWith(async (target) => {
      asked.push(target);
      return {
        bundleUrl: "https://private.blob.example/bundle.json?sig=1",
        ticketHash: HASH,
        bundle: {} as never,
        repoPublic: true,
      };
    });
    expect(asked).toEqual([
      {
        installationId: 177107116,
        repo: "sumithprabhu/demo-shop",
        prNumber: 7,
        runId: RUN,
        isFork: false,
      },
    ]);
    expect(calls[0]!.body).toMatchObject({
      bundleUrl: "https://private.blob.example/bundle.json?sig=1",
      intent: { criteria: [{ id: "C1" }], ticketHash: HASH },
      // §28: a public repo's GIFs go to the public store, to show inline.
      evidenceStore: "public",
    });
  });

  it("reuses the intent another PR of the repo read from the same ticket (P5 gate)", async () => {
    const other = await ensureRunGroup(t.db, repoId, 8);
    await t.db.insert(intentVersions).values({
      runGroupId: other.id,
      ticketHash: HASH,
      intentJson: { criteria: CRITERIA, intentSource: "linked_issue_video", ticketHash: HASH },
    });
    await drainWith(async () => ({
      bundleUrl: "https://private.blob.example/b.json",
      ticketHash: HASH,
      bundle: {} as never,
      repoPublic: false,
    }));
    expect(calls[0]!.body).toMatchObject({
      intent: { criteria: [{ id: "C1" }], ticketHash: HASH },
    });
  });

  it("never reuses an intent with no criteria: the job reads the ticket again", async () => {
    await t.db.insert(intentVersions).values({
      runGroupId: groupId,
      ticketHash: HASH,
      intentJson: { criteria: [], intentSource: "linked_issue_video", ticketHash: HASH },
    });
    await drainWith(async () => ({
      bundleUrl: "https://private.blob.example/b.json",
      ticketHash: HASH,
      bundle: {} as never,
      repoPublic: false,
    }));
    expect(calls[0]!.body).toMatchObject({ intent: null });
  });

  it("remembers the ticket, so the comment can name it", async () => {
    await drainWith(async () => ({
      bundleUrl: "https://private.blob.example/b.json",
      ticketHash: HASH,
      bundle: {
        ticket: {
          source: "github_issue",
          ref: "#5",
          title: "Discount codes",
          body: "",
          comments: [],
        },
      } as never,
      repoPublic: false,
    }));
    const [group] = await t.db.select().from(runGroups).where(eq(runGroups.id, groupId));
    expect(group).toMatchObject({ ticketRef: "#5", ticketTitle: "Discount codes" });
  });

  it("lets the job read a ticket no earlier run has read", async () => {
    await drainWith(async () => ({
      bundleUrl: "https://private.blob.example/b.json",
      ticketHash: "d".repeat(64),
      bundle: {} as never,
      repoPublic: false,
    }));
    expect(calls[0]!.body).toMatchObject({
      bundleUrl: "https://private.blob.example/b.json",
      intent: null,
      evidenceStore: "private",
    });
  });

  it("starts the job without a bundle when it can't be built, and says why", async () => {
    const lines: string[] = [];
    await drainWith(async () => {
      throw new Error("GET /repos/sumithprabhu/demo-shop/pulls/7: 502 Bad Gateway");
    }, lines);
    expect(calls[0]!.body).toMatchObject({
      bundleUrl: null,
      intent: null,
      evidenceStore: "private",
    });
    expect(lines).toEqual([
      "run 00000000: no context bundle: GET /repos/sumithprabhu/demo-shop/pulls/7: 502 Bad Gateway",
    ]);
  });
});

describe("the spawn effect", () => {
  it("starts a job on Modal with a token for it, and makes it the run's current job", async () => {
    await drain();
    const job = "0b0b0b0b-0000-4000-8000-000000000001";
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      endpoint: "spawn",
      auth: `Bearer ${MODAL.secret}`,
      body: {
        type: "verify",
        jobId: job,
        runId: RUN,
        callback: { baseUrl: MODAL.cloudUrl },
      },
    });
    expect(VerifyJob.safeParse(calls[0]!.body).success).toBe(true);
    const deadline = (await run()).deadlineAt!;
    expect(calls[0]!.body.deadlineAt).toBe(deadline.toISOString());
    const claims = verifyJobToken(JOB_SECRET, calls[0]!.body.callback.token, T0.getTime() / 1000);
    expect(claims).toEqual({ jobId: job, runId: RUN, exp: deadline.getTime() / 1000 + 300 });
    expect(await run()).toMatchObject({ currentJobId: job, modalCallId: "fc-01" });
  });

  it("starts nothing for a run that has moved on", async () => {
    await happen({ kind: "pr_pushed", headSha: "c5f46c1", draft: false });
    await drain();
    expect(calls.map((c) => c.endpoint)).toEqual([]);
    expect((await run()).currentJobId).toBeNull();
  });

  it("makes an earlier attempt's job stale when it has to start again", async () => {
    const [row] = await t.db.select().from(outbox).where(eq(outbox.effect, "spawn_job"));
    const spawn = spawnExecutor(deps());
    await spawn.run(row!);
    const first = (await run()).currentJobId!;
    await spawn.run(row!);
    const current = await run();
    expect(current.currentJobId).not.toBe(first);
    expect(isCurrentJob(current, first)).toBe(false);
  });

  it("sends the run's preview, its baseline and the repo's config (§8)", async () => {
    const config = IntenzoConfig.parse({ version: 1, start: { default: "/cart" } });
    await t.db.update(repos).set({ configJson: config }).where(eq(repos.id, repoId));
    await t.db
      .update(runs)
      .set({ baseUrl: "https://demo-shop-main.vercel.app", baseSha: BASE_SHA })
      .where(eq(runs.id, RUN));
    await drain();
    expect(calls[0]!.body).toMatchObject({
      prUrl: "https://demo-shop-x.vercel.app",
      baseUrl: "https://demo-shop-main.vercel.app",
      baseSha: BASE_SHA,
      config: { start: { default: "/cart" } },
      // Until P4: no context bundle, and the intent computed by the job. No paths saved yet.
      cachedPaths: [],
      bundleUrl: null,
      intent: null,
    });
  });

  it("sends the group's saved paths for its latest intent version (§19 3a)", async () => {
    const path = (criterionId: string, name: string) => ({
      criterionId,
      setup: [{ op: "goto", path: "/cart" }],
      trigger: [{ op: "click", target: { by: "role", role: "button", name } }],
      watch: [{ label: "summary", scope: "region", target: { by: "testId", id: "summary" } }],
      portable: true,
    });
    const intent = async (ticketHash: string) =>
      (
        await t.db
          .insert(intentVersions)
          .values({ runGroupId: groupId, ticketHash, intentJson: {} })
          .returning()
      )[0]!.id;
    const old = await intent("a".repeat(64));
    const latest = await intent("b".repeat(64));
    await t.db.insert(savedPaths).values([
      { runGroupId: groupId, criterionId: "C2", intentVersionId: old, pathJson: path("C2", "Old") },
      {
        runGroupId: groupId,
        criterionId: "C2",
        intentVersionId: latest,
        pathJson: path("C2", "Apply"),
      },
      {
        runGroupId: groupId,
        criterionId: "C3",
        intentVersionId: latest,
        pathJson: { not: "a path" },
      },
    ]);
    await drain();
    expect(calls[0]!.body.cachedPaths).toEqual([path("C2", "Apply")]);
  });

  it("opens the repo's secrets into the job of a PR from the repo itself", async () => {
    await setRepoSecrets(t.db, SECRETS_KEY, "sumithprabhu/demo-shop", {
      hookSecret: HOOK,
      bypass: BYPASS,
    });
    await drain();
    expect(calls[0]!.body.secrets).toEqual({ hookSecret: HOOK, bypass: BYPASS });
  });

  it("sends no secrets at all for a fork's PR (§29)", async () => {
    await setRepoSecrets(t.db, SECRETS_KEY, "sumithprabhu/demo-shop", { hookSecret: HOOK });
    await t.db.update(runGroups).set({ fromFork: true }).where(eq(runGroups.id, groupId));
    await drain();
    expect(calls[0]!.body.secrets).toBeNull();
  });

  it("sends empty secrets for a repo that has none", async () => {
    await drain(null);
    expect(calls[0]!.body.secrets).toEqual({});
  });

  it("starts no job while the repo's secrets can't be opened, and says why", async () => {
    await setRepoSecrets(t.db, SECRETS_KEY, "sumithprabhu/demo-shop", { bypass: BYPASS });
    expect(await drain(null)).toEqual({ done: 0, failed: 1 });
    expect(calls).toEqual([]);
    const [row] = await t.db.select().from(outbox).where(eq(outbox.effect, "spawn_job"));
    expect(row!.lastError).toBe(
      "sumithprabhu/demo-shop has sealed secrets, but INTENZO_SECRETS_KEY isn't set",
    );
    expect((await run()).currentJobId).toBeNull();
  });

  it("is tried again later when Modal refuses it", async () => {
    modal.use(http.post(MODAL.spawnUrl, () => new Response("upstream down", { status: 502 })));
    expect(await drain()).toEqual({ done: 0, failed: 1 });
    const [row] = await t.db.select().from(outbox).where(eq(outbox.effect, "spawn_job"));
    expect(row).toMatchObject({
      status: "pending",
      lastError: "Modal sumithprabhu--intenzo-worker-spawn.modal.run: 502 upstream down",
    });
  });
});

describe("the cancel effect", () => {
  it("cancels the run's Modal call when the run is superseded", async () => {
    await drain();
    await happen({ kind: "pr_pushed", headSha: "c5f46c1", draft: false });
    await drain();
    expect(calls.map((c) => `${c.endpoint} ${JSON.stringify(c.body.callId ?? "")}`)).toEqual([
      'spawn ""',
      'cancel "fc-01"',
    ]);
    // The new commit's run gets its own job once its preview is ready, not before.
    const kinds = await t.db.select().from(outbox).orderBy(asc(outbox.id));
    expect(kinds.filter((r) => r.effect === "cancel_job")).toMatchObject([{ status: "done" }]);
  });

  it("has nothing to cancel when no job was started", async () => {
    await t.db.delete(outbox).where(eq(outbox.effect, "spawn_job"));
    await happen({ kind: "pr_pushed", headSha: "c5f46c1", draft: false });
    expect(await drain()).toEqual({ done: 1, failed: 0 });
    expect(calls).toEqual([]);
  });
});
