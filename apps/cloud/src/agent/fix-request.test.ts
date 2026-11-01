import { readFileSync } from "node:fs";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { IntenzoConfig } from "@intenzo/core";
import { parseFixerComment, verifyFixerSig } from "@intenzo/core/fixer";

import { ensureRunGroup, saveConfig } from "../db/repos.ts";
import { criteriaResults, intentVersions, outbox, runGroups, runs } from "../db/schema.ts";
import { resetWithDemoShop, testDb } from "../db/test-db.ts";
import { githubClient } from "../github/api.ts";
import { fakeGitHub, json } from "../github/fake-github.ts";
import { eventHandlers } from "../github/handlers.ts";
import { agentExecutors } from "../outbox/agent-effects.ts";
import { drainOutbox } from "../outbox/drain.ts";
import { githubExecutors } from "../outbox/github-effects.ts";
import { advance } from "../runs/advance.ts";
import type { Fact } from "../runs/transition.ts";

const REPO = "/repos/sumithprabhu/demo-shop";
const T0 = Date.parse("2026-11-01T09:00:00.000Z");
const BASE = "https://intenzo-cloud.vercel.app";
const SECRET = "fixer-secret-for-the-cloud-tests-0123456789";
const runId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const C2 = JSON.parse(
  readFileSync(new URL("../../../../fixtures/criteria/C2.json", import.meta.url), "utf8"),
);

const github = fakeGitHub();
let t: Awaited<ReturnType<typeof testDb>>;
let groupId: number;
let ids: number;
let lines: string[];
let sent: { call: string; id: number; body: Record<string, any> }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
/** Each run's check run id, from the POST that created it. */
let checkRunOf: Map<string, number>;

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  const repo = await resetWithDemoShop(t.db);
  // demo-shop's policy, with two attempts so the test reaches the max.
  await saveConfig(
    t.db,
    repo.id,
    IntenzoConfig.parse({
      version: 1,
      policy: { agent_handle: "@intenzo-fixer", agent_trigger: "button", max_agent_attempts: 2 },
    }),
  );
  groupId = (await ensureRunGroup(t.db, repo.id, 7)).id;
  ids = 0;
  lines = [];
  sent = [];
  checkRunOf = new Map();
  // GitHub, recording what Intenzo sends: check runs, the comment, fix requests and labels.
  let next = 9000;
  const record = (kind: string) => async (request: Request) => {
    const patched = request.method === "PATCH";
    const id = patched ? Number(new URL(request.url).pathname.split("/").at(-1)) : ++next;
    const body = (await request.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!patched && kind === "check-runs") checkRunOf.set(body.external_id, id);
    sent.push({ call: patched ? `PATCH ${kind}` : `POST ${kind}`, id, body });
    return json({ id }, patched ? 200 : 201);
  };
  github.get(`${REPO}/commits/:sha/check-runs`, { total_count: 0, check_runs: [] });
  github.post(`${REPO}/check-runs`, record("check-runs"));
  github.patch(`${REPO}/check-runs/:id`, record("check-runs"));
  github.get(`${REPO}/issues/7/comments`, []);
  github.post(`${REPO}/issues/7/comments`, record("comment"));
  github.patch(`${REPO}/issues/comments/:id`, record("comment"));
  github.post(`${REPO}/issues/7/labels`, async (request: Request) => {
    sent.push({
      call: "POST labels",
      id: 0,
      body: (await request.json()) as Record<string, unknown>,
    });
    return json([{ name: "needs-human" }]);
  });
});

const happen = (fact: Fact, minute = 0) =>
  advance(t.db, groupId, fact, {
    now: new Date(T0 + minute * 60_000),
    newRunId: () => runId(++ids),
  });

const drain = (fixerSecret: string | null = SECRET) =>
  drainOutbox({
    db: t.db,
    executors: {
      ...agentExecutors({
        db: t.db,
        github: () => githubClient(async () => "ghs_test"),
        reportBaseUrl: BASE,
        fixerSecret,
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

let presses = 0;
/** A press of a button on a run's check run, as GitHub delivers it (§26.2). */
const press = (run: string, identifier = "fix") =>
  eventHandlers({
    db: t.db,
    github: () => githubClient(async () => "ghs_test"),
    now: () => new Date(T0),
    newRunId: () => runId(++ids),
    log: (line) => lines.push(line),
    drain: () => drain(),
  }).check_run!({
    id: ++presses,
    deliveryId: `press-${presses}`,
    event: "check_run",
    action: "requested_action",
    payload: {
      action: "requested_action",
      check_run: { external_id: run },
      requested_action: { identifier },
      sender: { login: "sumithprabhu" },
      // As GitHub sends it: the installation and repo resetWithDemoShop seeds.
      installation: { id: 177107116 },
      repository: {
        id: 1_087_000_001,
        full_name: "sumithprabhu/demo-shop",
        default_branch: "main",
        owner: { login: "sumithprabhu" },
      },
    },
  });

/** The PR at `sha` gets a run that the judges fail on C2, with what a fix request is built from. */
async function failedRun(sha: string, minute: number, outcome: "fail" | "pass" = "fail") {
  await happen(
    minute === 0
      ? { kind: "pr_ready", trigger: "opened", headSha: sha, draft: false }
      : { kind: "pr_pushed", headSha: sha, draft: false },
    minute,
  );
  await happen(
    { kind: "preview_ready", sha, url: `https://shop-${sha.slice(0, 7)}.vercel.app` },
    minute,
  );
  const id = runId(ids);
  const [intent] = await t.db
    .insert(intentVersions)
    .values({
      runGroupId: groupId,
      ticketHash: `${sha.slice(0, 1)}`.repeat(64),
      intentJson: {
        criteria: [C2],
        intentSource: "linked_issue_video",
        ticketHash: "a".repeat(64),
      },
    })
    .returning();
  await t.db
    .update(runs)
    .set({
      intentVersionId: intent!.id,
      coverageJson: {
        items: [
          {
            criterionId: "C2",
            files: ["components/CartView.tsx", "lib/cart.ts"],
            status: "covered",
          },
        ],
        routes: ["/cart"],
      },
    })
    .where(eq(runs.id, id));
  const tt = T0 + 10_000;
  await t.db.insert(criteriaResults).values({
    runId: id,
    criterionId: "C2",
    verdict: outcome,
    reasonCode: "agreed",
    judgesJson: [],
    evidenceJson: { window: null, observed: "The total stayed $50.00 a second after Apply." },
    lanesJson: [
      {
        criterionId: "C2",
        side: "pr",
        status: "completed",
        laneStartMs: T0,
        tTriggerMs: tt,
        stepLog: [
          { tMs: T0 + 1000, step: { op: "goto", path: "/cart" }, ok: true, trigger: false },
          {
            tMs: tt - 500,
            step: {
              op: "fill",
              target: { by: "role", role: "textbox", name: "Discount code" },
              value: "SAVE10",
            },
            ok: true,
            trigger: true,
          },
          {
            tMs: tt,
            step: { op: "click", target: { by: "role", role: "button", name: "Apply" } },
            ok: true,
            trigger: true,
          },
        ],
        readings: [
          {
            i: 0,
            label: "order total",
            kind: "text",
            phase: "pre",
            tMs: tt - 1000,
            value: "$50.00",
            bbox: null,
          },
          {
            i: 1,
            label: "order total",
            kind: "text",
            phase: "post",
            tMs: tt,
            value: "$50.00",
            bbox: null,
          },
          {
            i: 2,
            label: "order total",
            kind: "text",
            phase: "post",
            tMs: tt + 1000,
            value: "$50.00",
            bbox: null,
          },
          {
            i: 3,
            label: "order total",
            kind: "text",
            phase: "after_reload",
            tMs: tt + 5000,
            value: "$45.00",
            bbox: null,
          },
        ],
      },
    ],
  });
  await happen({ kind: "job_finished", runId: id, outcome }, minute + 2);
  await drain();
  return id;
}

// A fix request carries the payload's header; the report comment only names the agent.
const requests = () =>
  sent.filter((s) => s.call === "POST comment" && s.body.body.includes("UNTRUSTED DATA"));
const agentRows = () => t.db.select().from(outbox).where(eq(outbox.effect, "agent"));
const attempts = async () =>
  (await t.db.select().from(runGroups).where(eq(runGroups.id, groupId)))[0]!.agentAttempts;
/** The buttons on a run's check run, as last sent. */
const buttonsOf = (run: string) =>
  sent
    .filter((s) => s.call.endsWith("check-runs") && s.id === checkRunOf.get(run))
    .at(-1)
    ?.body.actions.map((a: { identifier: string }) => a.identifier);

describe("Send to agent (§26.2, §26.3)", () => {
  it("sends one signed fix request for two quick presses, with what the judges saw", async () => {
    const run1 = await failedRun("a".repeat(40), 0);
    await Promise.all([press(run1), press(run1)]);

    expect(await agentRows()).toHaveLength(1);
    expect((await agentRows())[0]!.idemKey).toBe(`agent:${groupId}:1`);
    expect(await attempts()).toBe(1);
    expect(lines.filter((l) => l.includes("Send to agent"))).toEqual([
      `run ${run1.slice(0, 8)}: sumithprabhu pressed Send to agent: fix request 1 queued`,
      `run ${run1.slice(0, 8)}: sumithprabhu pressed Send to agent: not sent, this run's fix was already requested`,
    ]);

    expect(requests()).toHaveLength(1);
    // GitHub shows nothing on a press: the report comment says the request went out.
    const report = sent.filter((s) => s.call === "PATCH comment").at(-1)!.body.body as string;
    expect(report).toContain("🤖 Sent to `@intenzo-fixer` for a fix (request 1 of 2)");
    const request = parseFixerComment(requests()[0]!.body.body)!;
    expect(verifyFixerSig(SECRET, request)).toBe(true);
    expect(request).toMatchObject({
      runId: run1,
      headSha: "a".repeat(40),
      files: ["components/CartView.tsx", "lib/cart.ts"],
      report: `${BASE}/r/${run1}`,
      criteria: [
        {
          id: "C2",
          text: C2.text,
          expected: C2.expected,
          observed: "The total stayed $50.00 a second after Apply.",
          readings: [
            { label: "order total", value: "+0 s $50.00" },
            { label: "order total", value: "+1 s $50.00" },
            { label: "order total", value: "after reload $45.00" },
          ],
          steps: ['fill: Discount code = "SAVE10"', "click: Apply"],
        },
      ],
    });
  });

  it("counts one request per failed run, and at the max the button is gone and the label is set", async () => {
    const run1 = await failedRun("a".repeat(40), 0);
    expect(buttonsOf(run1)).toEqual(["fix", "rerun"]);
    await press(run1);
    // One attempt of two used: the run's check run, drawn again, still offers it.
    expect(sent.filter((s) => s.id === checkRunOf.get(run1)).at(-1)?.call).toBe("PATCH check-runs");
    expect(buttonsOf(run1)).toEqual(["fix", "rerun"]);

    const run2 = await failedRun("b".repeat(40), 10);
    await press(run2);
    expect((await agentRows()).map((r) => r.idemKey)).toEqual([
      `agent:${groupId}:1`,
      `agent:${groupId}:2`,
    ]);
    expect(await attempts()).toBe(2);
    // Redrawn after the second press: no attempts left, so no Send to agent.
    expect(buttonsOf(run2)).toEqual(["rerun"]);
    expect(sent.some((s) => s.call === "POST labels")).toBe(false);

    // The agent's last fix still fails: a human is needed.
    const run3 = await failedRun("c".repeat(40), 20);
    expect(buttonsOf(run3)).toEqual(["rerun"]);
    expect(sent.filter((s) => s.call === "POST labels").map((s) => s.body)).toEqual([
      { labels: ["needs-human"] },
    ]);
    await press(run3);
    expect(lines.at(-1)).toContain("not sent, the agent's attempts are used up");
    expect(await agentRows()).toHaveLength(2);
    expect(requests()).toHaveLength(2);
  });

  it("refuses a press on a run that passed, or that a newer run replaced", async () => {
    const passed = await failedRun("a".repeat(40), 0, "pass");
    await press(passed);
    expect(lines.at(-1)).toContain("not sent, the run ended pass");

    const failed = await failedRun("b".repeat(40), 10);
    await happen({ kind: "pr_pushed", headSha: "c".repeat(40), draft: false }, 15);
    await press(failed);
    expect(lines.at(-1)).toContain("not sent, a newer run replaced it");
    expect(await agentRows()).toHaveLength(0);
    expect(await attempts()).toBe(0);
  });

  it("logs the buttons it doesn't handle yet, and posts nothing without the fixer secret", async () => {
    const run1 = await failedRun("a".repeat(40), 0);
    await press(run1, "rerun");
    expect(lines.at(-1)).toContain("pressed rerun, which isn't handled yet");

    // A Cloud without INTENZO_FIXER_SECRET: the request is lost, not retried (at most once).
    await t.db.insert(outbox).values({
      runId: run1,
      groupId,
      effect: "agent",
      idemKey: `agent:${groupId}:9`,
      payloadJson: { kind: "agent", runId: run1, attempt: 9 },
    });
    await drain(null);
    const [row] = await t.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.effect, "agent"), eq(outbox.idemKey, `agent:${groupId}:9`)));
    expect(row!.lastError).toContain("INTENZO_FIXER_SECRET isn't set");
    expect(requests()).toHaveLength(0);
  });
});
