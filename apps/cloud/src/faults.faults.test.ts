import { readFileSync } from "node:fs";

import { asc, eq, ne } from "drizzle-orm";
import { http } from "msw/http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { deployments, outbox, runs } from "./db/schema.ts";
import { resetWithDemoShop, testDb } from "./db/test-db.ts";
import { markFailed, markProcessed, recordWebhookEvent } from "./db/webhook-events.ts";
import type { ModalSettings } from "./env.ts";
import { githubClient } from "./github/api.ts";
import { createDispatcher } from "./github/dispatch.ts";
import { fakeGitHub, json, notFound } from "./github/fake-github.ts";
import { eventHandlers } from "./github/handlers.ts";
import { handleWebhook } from "./github/intake.ts";
import { signWebhook } from "./github/signature.ts";
import { signJobToken } from "./jobs/token.ts";
import { handleWorkerEvent } from "./jobs/worker-api.ts";
import { drainOutbox } from "./outbox/drain.ts";
import { githubExecutors } from "./outbox/github-effects.ts";
import { jobExecutors } from "./outbox/job-effects.ts";

// T7.1, the Cloud's faults: duplicate webhooks, a deployment before its PR, and Modal cancelling a
// job mid-run. Each goes through what production runs: the webhook intake (signature, the
// delivery stored once), the handlers, advance() and the outbox drained into a stateful fake
// GitHub and a fake Modal. Each must end in the state ARCHITECTURE documents (§16, §17, §22.5):
// one run per head, one check run per run, one comment per PR, and nothing left in the outbox.

// The T0.4 sandbox's real deliveries (packages/core/fixtures/github/README.md): PR #2 opened at
// a412468 and pushed to 39eed67, which Vercel deploys as a Preview.
const FIXTURES = new URL("../../../packages/core/fixtures/", import.meta.url);
type Payload = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fixture = (name: string): { event: string; payload: Payload } =>
  JSON.parse(readFileSync(new URL(`github/${name}.json`, FIXTURES), "utf8"));
const CONFIG = readFileSync(new URL("config/demo-shop.intenzo.yml", FIXTURES), "utf8");

const REPO = "/repos/sumithprabhu/intenzo-t04-sandbox";
const OPENED = "a4124687db94bef0fc223cba34479050371f66f1";
const PUSHED = "39eed67b0ce64a98c3da2f723f7ec61f663d0076";
const MERGE_BASE = "8440e97436555a6b7ccf94b58c5e8d5c536ab38b";
const PR_URL = "https://intenzo-t04-sandbox-hnx4nfyzw-sumithprabhus-projects.vercel.app";
const WEBHOOK_SECRET = "a-webhook-secret-for-the-fault-tests";
const JOB_SECRET = "a-job-secret-for-tests-only-0123456789";
const NOW = new Date("2026-11-01T09:00:00.000Z");
const MODAL: ModalSettings = {
  spawnUrl: "https://faults--intenzo-worker-spawn.modal.run",
  cancelUrl: "https://faults--intenzo-worker-cancel.modal.run",
  secret: "a-modal-endpoint-secret-for-tests-01234",
  cloudUrl: "https://intenzo-cloud.test",
};

const github = fakeGitHub();
let t: Awaited<ReturnType<typeof testDb>>;
let ids: number;
let jobIds: number;
let lines: string[];
/** GitHub's side: the check runs and comments Intenzo made, as GitHub keeps them. */
let hub: {
  checkRuns: Map<number, { externalId: string; status?: string; conclusion?: string }>;
  comments: Map<number, string>;
};
/** Modal's side: each spawn and cancel it was asked for. */
let modal: { endpoint: "spawn" | "cancel"; body: any }[]; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetWithDemoShop(t.db);
  ids = 0;
  jobIds = 0;
  lines = [];
  hub = { checkRuns: new Map(), comments: new Map() };
  modal = [];
});

const client = () => githubClient(async () => "ghs_test");
const log = (line: string) => lines.push(line);
const newRunId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
const drain = () =>
  drainOutbox({
    db: t.db,
    executors: {
      ...githubExecutors({ db: t.db, github: client, reportBaseUrl: MODAL.cloudUrl }),
      ...jobExecutors({
        db: t.db,
        modal: MODAL,
        jobSecret: JOB_SECRET,
        secretsKey: null,
        newJobId: () => `00000000-0000-4000-9000-${String(++jobIds).padStart(12, "0")}`,
        now: () => NOW,
        log,
      }),
    },
    now: () => NOW,
    log,
  });

/**
 * The sandbox as GitHub answers for it: its config, previews and open PRs, the baseline lookups,
 * and check runs and comments kept as GitHub keeps them. Modal answers on the same fake server.
 */
function sandbox({
  previews = {} as Record<string, string>,
  pulls = { 2: { head: PUSHED, commits: [OPENED, PUSHED] } } as Record<
    number,
    { head: string; commits: string[] }
  >,
} = {}) {
  github.get(`${REPO}/contents/.intenzo.yml`, () => new Response(CONFIG));
  github.get(`${REPO}/contents/.intenzo.yaml`, notFound);
  github.get(`${REPO}/deployments`, (request: Request) => {
    const sha = new URL(request.url).searchParams.get("sha")!;
    return previews[sha] ? [{ id: 40, sha, environment: "Preview" }] : [];
  });
  github.get(`${REPO}/deployments/40/statuses`, () => {
    const url = Object.values(previews)[0];
    return url ? [{ state: "success", environment_url: url }] : [];
  });
  github.get(`${REPO}/commits/:sha/pulls`, (request: Request) => {
    const sha = new URL(request.url).pathname.split("/")[5]!;
    return Object.entries(pulls)
      .filter(([, pr]) => pr.commits.includes(sha))
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
  github.get(`${REPO}/commits/7d1e2f3`, { sha: "7d1e2f3", parents: [] });

  let next = 9000;
  github.get(`${REPO}/commits/:sha/check-runs`, () => ({
    total_count: hub.checkRuns.size,
    check_runs: [...hub.checkRuns].map(([id, c]) => ({ id, external_id: c.externalId })),
  }));
  github.post(`${REPO}/check-runs`, async (request: Request) => {
    const body = (await request.json()) as Record<string, string>;
    const id = ++next;
    hub.checkRuns.set(id, {
      externalId: body.external_id!,
      ...(body.status && { status: body.status }),
      ...(body.conclusion && { conclusion: body.conclusion }),
    });
    return json({ id }, 201);
  });
  github.patch(`${REPO}/check-runs/:id`, async (request: Request) => {
    const id = Number(new URL(request.url).pathname.split("/").at(-1));
    const body = (await request.json()) as Record<string, string>;
    hub.checkRuns.set(id, { ...hub.checkRuns.get(id)!, ...body });
    return json({ id });
  });
  github.get(`${REPO}/issues/2/comments`, () =>
    [...hub.comments].map(([id, body]) => ({ id, body, user: { type: "Bot" } })),
  );
  github.post(`${REPO}/issues/2/comments`, async (request: Request) => {
    const id = ++next;
    hub.comments.set(id, ((await request.json()) as { body: string }).body);
    return json({ id }, 201);
  });
  github.patch(`${REPO}/issues/comments/:id`, async (request: Request) => {
    const id = Number(new URL(request.url).pathname.split("/").at(-1));
    hub.comments.set(id, ((await request.json()) as { body: string }).body);
    return json({ id });
  });
  let calls = 0;
  github.use(
    http.post(MODAL.spawnUrl, async ({ request }) => {
      modal.push({ endpoint: "spawn", body: await request.json() });
      return Response.json({ callId: `fc-${++calls}` });
    }),
    http.post(MODAL.cancelUrl, async ({ request }) => {
      const body = (await request.json()) as { callId: string };
      modal.push({ endpoint: "cancel", body });
      return Response.json({ cancelled: body.callId });
    }),
  );
}

/** A webhook through the intake, as GitHub sends it; then what the route defers to after(). */
async function deliver(name: string, deliveryId: string, edit: (p: Payload) => void = () => {}) {
  const { event, payload } = fixture(name);
  edit(payload);
  const body = JSON.stringify(payload);
  const deferred: (() => Promise<void>)[] = [];
  const response = await handleWebhook(
    new Request(`${MODAL.cloudUrl}/api/github/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": signWebhook(WEBHOOK_SECRET, body),
      },
      body,
    }),
    {
      secret: WEBHOOK_SECRET,
      appId: 1,
      record: (e) => recordWebhookEvent(t.db, e),
      dispatch: createDispatcher({
        handlers: eventHandlers({ db: t.db, github: client, now: () => NOW, newRunId, log, drain }),
        markProcessed: (id, at) => markProcessed(t.db, id, at),
        markFailed: (id, error) => markFailed(t.db, id, error),
        now: () => NOW,
        log,
      }),
      defer: (work) => deferred.push(work),
      now: () => NOW,
    },
  );
  await Promise.all(deferred.map((work) => work()));
  return { status: response.status, body: await response.json() };
}

const openedAt = (sha: string) => (p: Payload) => {
  p.pull_request.head.sha = sha;
};

/** A job's event, as the worker POSTs it with its token. */
async function report(runId: string, jobId: string, event: Record<string, unknown>) {
  const token = signJobToken(JOB_SECRET, { jobId, runId, exp: NOW.getTime() / 1000 + 600 });
  const response = await handleWorkerEvent(
    new Request(`${MODAL.cloudUrl}/api/worker/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jobId, ...event }),
    }),
    { db: t.db, secret: JOB_SECRET, now: () => NOW, newRunId, drain, log },
  );
  return response.status;
}

const allRuns = () => t.db.select().from(runs).orderBy(asc(runs.createdAt), asc(runs.id));
const runOf = async (sha: string) => (await allRuns()).filter((r) => r.headSha === sha);
/** §16.4: every effect done; one left pending or failed would be a hang. */
const unfinished = () =>
  t.db
    .select({ key: outbox.idemKey, status: outbox.status })
    .from(outbox)
    .where(ne(outbox.status, "done"));
const spawns = () => modal.filter((m) => m.endpoint === "spawn");

describe("duplicate webhooks (§16.4, §17)", () => {
  it("a redelivery (the same delivery id) is stored once and changes nothing", async () => {
    sandbox({ previews: { [OPENED]: PR_URL } });
    expect(await deliver("pull_request.opened", "d-opened")).toMatchObject({ status: 202 });
    expect(await deliver("pull_request.opened", "d-opened")).toEqual({
      status: 200,
      body: { status: "duplicate" },
    });

    expect(await allRuns()).toMatchObject([{ headSha: OPENED, state: "verifying" }]);
    expect(spawns()).toHaveLength(1);
    expect(hub.checkRuns.size).toBe(1);
    expect(hub.comments.size).toBe(1);
    expect(await unfinished()).toEqual([]);
  });

  it("the same events under new delivery ids, while their run is active, start nothing new", async () => {
    sandbox({ previews: { [PUSHED]: PR_URL } });
    await deliver("pull_request.opened", "d-1", openedAt(PUSHED));
    await deliver("pull_request.opened", "d-2", openedAt(PUSHED));
    await deliver("deployment_status.success.preview", "d-3");
    await deliver("deployment_status.success.preview", "d-4");

    expect(await allRuns()).toMatchObject([{ headSha: PUSHED, state: "verifying", prUrl: PR_URL }]);
    expect(spawns()).toHaveLength(1);
    expect([hub.checkRuns.size, hub.comments.size]).toEqual([1, 1]);
    expect(await unfinished()).toEqual([]);
  });
});

describe("a deployment that arrives before its PR (§16.2)", () => {
  it("is stored and starts nothing; the PR's run then finds it and verifies at once", async () => {
    // No open PR contains 39eed67 yet: GitHub lists none for it.
    sandbox({ pulls: {} });
    await deliver("deployment_status.success.preview", "d-preview");
    expect(await allRuns()).toEqual([]);
    expect(await t.db.select().from(deployments)).toMatchObject([{ sha: PUSHED, url: PR_URL }]);
    expect([hub.checkRuns.size, hub.comments.size, modal.length]).toEqual([0, 0, 0]);

    await deliver("pull_request.opened", "d-opened", openedAt(PUSHED));
    expect(await allRuns()).toMatchObject([{ headSha: PUSHED, state: "verifying", prUrl: PR_URL }]);
    expect(spawns()).toHaveLength(1);
    expect(spawns()[0]!.body).toMatchObject({ prUrl: PR_URL });
    expect([...hub.checkRuns.values()]).toMatchObject([{ status: "in_progress" }]);
    expect(hub.comments.size).toBe(1);
    expect(await unfinished()).toEqual([]);
  });
});

describe("Modal cancelling a job mid-run (§16.3, §22.5)", () => {
  it("the shim reports it cancelled: the run, its check run and the one comment say so", async () => {
    sandbox({ previews: { [PUSHED]: PR_URL } });
    await deliver("pull_request.opened", "d-opened", openedAt(PUSHED));
    const [run] = await runOf(PUSHED);
    const job = run!.currentJobId!;
    expect(await report(run!.id, job, { kind: "started", seq: 0 })).toBe(202);

    // The shim's own report, after Modal cancelled the input (modal/shim.py).
    const cancelled = { code: "cancelled", message: "cancelled by Modal" };
    expect(await report(run!.id, job, { kind: "failed", seq: 1_000_000, error: cancelled })).toBe(
      202,
    );

    expect(await runOf(PUSHED)).toMatchObject([
      { state: "done", outcome: "cancelled", outcomeReason: "worker_failed" },
    ]);
    expect([...hub.checkRuns.values()]).toMatchObject([
      { status: "completed", conclusion: "cancelled" },
    ]);
    expect(hub.comments.size).toBe(1);
    expect([...hub.comments.values()][0]).toContain("was cancelled.");
    // The job is over: anything it still sends is refused.
    expect(await report(run!.id, job, { kind: "started", seq: 1 })).toBe(410);
    expect(await unfinished()).toEqual([]);
  });

  it("a push supersedes the running job: Modal is told to cancel it once, and its late report is refused", async () => {
    sandbox({ previews: { [OPENED]: PR_URL } });
    await deliver("pull_request.opened", "d-opened");
    const [first] = await runOf(OPENED);
    const job = first!.currentJobId!;
    expect(await report(first!.id, job, { kind: "started", seq: 0 })).toBe(202);

    await deliver("pull_request.synchronize", "d-pushed");
    expect(modal.filter((m) => m.endpoint === "cancel")).toEqual([
      { endpoint: "cancel", body: expect.objectContaining({ callId: "fc-1" }) },
    ]);
    expect(await runOf(OPENED)).toMatchObject([{ state: "done", outcome: "superseded" }]);
    expect(await runOf(PUSHED)).toMatchObject([{ state: "waiting_inputs" }]);

    // The cancelled job's shim reports it, too late: the run is no longer its.
    const cancelled = { code: "cancelled", message: "cancelled by Modal" };
    expect(await report(first!.id, job, { kind: "failed", seq: 1_000_000, error: cancelled })).toBe(
      410,
    );
    const checks = [...hub.checkRuns.values()].map((c) =>
      `${c.status} ${c.conclusion ?? ""}`.trim(),
    );
    expect(checks).toEqual(["completed neutral", "queued"]);
    expect(hub.comments.size).toBe(1);
    expect(await unfinished()).toEqual([]);
  });
});

describe("the outbox after every fault", () => {
  it("a drain with nothing due does nothing: no fault leaves work behind", async () => {
    sandbox({ previews: { [PUSHED]: PR_URL } });
    await deliver("pull_request.opened", "d-opened", openedAt(PUSHED));
    const before = { checks: hub.checkRuns.size, comments: hub.comments.size, modal: modal.length };
    await drain();
    expect({
      checks: hub.checkRuns.size,
      comments: hub.comments.size,
      modal: modal.length,
    }).toEqual(before);
    expect(lines.filter((l) => /failed|error/i.test(l))).toEqual([]);
    expect((await t.db.select().from(runs).where(eq(runs.headSha, PUSHED))).length).toBe(1);
  });
});
