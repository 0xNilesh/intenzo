import type { RunOutcome } from "@intenzo/core";
import { describe, expect, it } from "vitest";

import {
  conclusionFor,
  decide,
  type Effect,
  type Fact,
  type Group,
  PREVIEW_WAIT_MS,
  type Run,
  transition,
  VERIFY_DEADLINE_MS,
} from "./transition.ts";

const T0 = Date.parse("2026-10-31T09:00:00.000Z");
const at = (minute: number) => new Date(T0 + minute * 60_000);
const urlOf = (sha: string) => `https://demo-shop-git-${sha.toLowerCase()}.vercel.app`;

const opened = (headSha: string, draft = false): Fact => ({
  kind: "pr_ready",
  trigger: "opened",
  headSha,
  draft,
});
const reopened = (headSha: string): Fact => ({
  kind: "pr_ready",
  trigger: "reopened",
  headSha,
  draft: false,
});
const readyForReview = (headSha: string): Fact => ({
  kind: "pr_ready",
  trigger: "ready_for_review",
  headSha,
  draft: false,
});
const pushed = (headSha: string, draft = false): Fact => ({ kind: "pr_pushed", headSha, draft });
const preview = (sha: string, url = urlOf(sha)): Fact => ({ kind: "preview_ready", sha, url });
const previewFailed = (sha: string): Fact => ({ kind: "preview_failed", sha });
const tick: Fact = { kind: "tick" };
const jobFinished = (runId: string, outcome: RunOutcome = "pass"): Fact => ({
  kind: "job_finished",
  runId,
  outcome,
});
const jobFailed = (runId: string, code = "crash"): Fact => ({ kind: "job_failed", runId, code });

type Steps = readonly (readonly [minute: number, fact: Fact])[];

/**
 * Plays facts through decide() the way the handlers will: a successful deployment is stored
 * (deployments upsert) before the group is advanced, so later runs find it by lookup (§16.2).
 */
function simulate(
  steps: Steps,
  inconclusiveConclusion: Group["inconclusiveConclusion"] = "neutral",
) {
  let runs: Run[] = [];
  const previews = new Map<string, string>();
  const effects: string[][] = [];
  let ids = 0;
  for (const [minute, fact] of steps) {
    if (fact.kind === "preview_ready") previews.set(fact.sha, fact.url);
    const decision = decide({ id: 7, runs, previews, inconclusiveConclusion }, fact, {
      now: at(minute),
      newRunId: () => `run-${++ids}`,
    });
    runs = [
      ...runs.map((r) => decision.updated.find((u) => u.id === r.id) ?? r),
      ...decision.created,
    ];
    effects.push(decision.effects.map(describeEffect));
  }
  return { runs, effects, summaries: runs.map(summarize) };
}

function describeEffect(e: Effect): string {
  switch (e.kind) {
    case "check_run":
      return `check ${e.runId} ${e.status}${e.conclusion ? ` ${e.conclusion}` : ""}`;
    case "comment":
      return `comment ${e.groupId}`;
    case "spawn_job":
      return `spawn ${e.runId}`;
    case "cancel_job":
      return `cancel ${e.runId}`;
  }
}

/** "A#1 opened verifying", "A#1 opened done/inconclusive (preview_not_ready)". */
function summarize(r: Run): string {
  const outcome = r.outcome ? `/${r.outcome}` : "";
  const reason = r.outcomeReason ? ` (${r.outcomeReason})` : "";
  return `${r.headSha}#${r.attemptNo} ${r.trigger} ${r.state}${outcome}${reason}`;
}

describe("decide", () => {
  // The roadmap's T2.2 cases first, then the edges around them.
  it.each<{ name: string; steps: Steps; runs: string[]; effects: string[][] }>([
    {
      name: "PR opened, then deployment",
      steps: [
        [0, opened("A")],
        [3, preview("A")],
      ],
      runs: ["A#1 opened verifying"],
      effects: [
        ["check run-1 queued", "comment 7"],
        ["check run-1 in_progress", "spawn run-1", "comment 7"],
      ],
    },
    {
      name: "deployment, then PR opened",
      steps: [
        [0, preview("A")],
        [1, opened("A")],
      ],
      runs: ["A#1 opened verifying"],
      effects: [[], ["check run-1 in_progress", "spawn run-1", "comment 7"]],
    },
    {
      name: "draft → ready without a new deployment (found by lookup)",
      steps: [
        [0, opened("A", true)],
        [2, preview("A")],
        [5, readyForReview("A")],
      ],
      runs: ["A#1 ready_for_review verifying"],
      effects: [[], [], ["check run-1 in_progress", "spawn run-1", "comment 7"]],
    },
    {
      name: "a deployment for a SHA with no open PR (ignored)",
      steps: [
        [0, opened("A")],
        [1, preview("MAIN")],
      ],
      runs: ["A#1 opened waiting_inputs"],
      effects: [["check run-1 queued", "comment 7"], []],
    },
    {
      name: "a new SHA supersedes the active run",
      steps: [
        [0, opened("A")],
        [2, preview("A")],
        [4, pushed("B")],
      ],
      runs: ["A#1 opened done/superseded", "B#1 synchronize waiting_inputs"],
      effects: [
        ["check run-1 queued", "comment 7"],
        ["check run-1 in_progress", "spawn run-1", "comment 7"],
        ["cancel run-1", "check run-1 completed neutral", "check run-2 queued", "comment 7"],
      ],
    },
    {
      name: "a 20-minute timeout, then a late deployment re-opens the run",
      steps: [
        [0, opened("A")],
        [19, tick],
        [20, tick],
        [45, preview("A")],
      ],
      runs: ["A#1 opened done/inconclusive (preview_not_ready)", "A#2 late_preview verifying"],
      effects: [
        ["check run-1 queued", "comment 7"],
        [],
        ["check run-1 completed neutral", "comment 7"],
        ["check run-2 in_progress", "spawn run-2", "comment 7"],
      ],
    },
    {
      name: "a deployment more than 2 h after the timeout doesn't re-open it",
      steps: [
        [0, opened("A")],
        [20, tick],
        [141, preview("A")],
      ],
      runs: ["A#1 opened done/inconclusive (preview_not_ready)"],
      effects: [
        ["check run-1 queued", "comment 7"],
        ["check run-1 completed neutral", "comment 7"],
        [],
      ],
    },
    {
      name: "a failed deployment ends the waiting run inconclusive",
      steps: [
        [0, opened("A")],
        [2, previewFailed("A")],
      ],
      runs: ["A#1 opened done/inconclusive (preview_failed)"],
      effects: [
        ["check run-1 queued", "comment 7"],
        ["check run-1 completed neutral", "comment 7"],
      ],
    },
    {
      name: "a verifying run past its 15-minute deadline ends in error, and its job is cancelled",
      steps: [
        [0, opened("A")],
        [1, preview("A")],
        [15, tick],
        [16, tick],
      ],
      runs: ["A#1 opened done/error (deadline_passed)"],
      effects: [
        ["check run-1 queued", "comment 7"],
        ["check run-1 in_progress", "spawn run-1", "comment 7"],
        [],
        ["cancel run-1", "check run-1 completed neutral", "comment 7"],
      ],
    },
    {
      name: "another ready event for the same commit adds no run",
      steps: [
        [0, opened("A")],
        [1, reopened("A")],
        [2, readyForReview("A")],
      ],
      runs: ["A#1 opened waiting_inputs"],
      effects: [["check run-1 queued", "comment 7"], [], []],
    },
    {
      name: "a push to a draft PR supersedes the run without starting another",
      steps: [
        [0, opened("A")],
        [1, pushed("B", true)],
      ],
      runs: ["A#1 opened done/superseded"],
      effects: [
        ["check run-1 queued", "comment 7"],
        ["check run-1 completed neutral", "comment 7"],
      ],
    },
    {
      name: "a redeploy of a commit that's already verifying changes nothing",
      steps: [
        [0, opened("A")],
        [1, preview("A")],
        [3, preview("A", "https://demo-shop-redeploy.vercel.app")],
      ],
      runs: ["A#1 opened verifying"],
      effects: [
        ["check run-1 queued", "comment 7"],
        ["check run-1 in_progress", "spawn run-1", "comment 7"],
        [],
      ],
    },
    {
      name: "a reopened PR whose run timed out long ago gets attempt 2 for the same commit",
      steps: [
        [0, opened("A")],
        [20, tick],
        [200, reopened("A")],
      ],
      runs: ["A#1 opened done/inconclusive (preview_not_ready)", "A#2 reopened waiting_inputs"],
      effects: [
        ["check run-1 queued", "comment 7"],
        ["check run-1 completed neutral", "comment 7"],
        ["check run-2 queued", "comment 7"],
      ],
    },
    {
      name: "the job finishes: its run ends with the job's outcome, and nothing is cancelled",
      steps: [
        [0, opened("A")],
        [1, preview("A")],
        [5, jobFinished("run-1", "fail")],
      ],
      runs: ["A#1 opened done/fail"],
      effects: [
        ["check run-1 queued", "comment 7"],
        ["check run-1 in_progress", "spawn run-1", "comment 7"],
        ["check run-1 completed failure", "comment 7"],
      ],
    },
    {
      name: "the job fails: its run ends in error",
      steps: [
        [0, opened("A")],
        [1, preview("A")],
        [3, jobFailed("run-1", "crash")],
      ],
      runs: ["A#1 opened done/error (worker_failed)"],
      effects: [
        ["check run-1 queued", "comment 7"],
        ["check run-1 in_progress", "spawn run-1", "comment 7"],
        ["check run-1 completed neutral", "comment 7"],
      ],
    },
    {
      name: "the shim reports the job cancelled: its run ends cancelled",
      steps: [
        [0, opened("A")],
        [1, preview("A")],
        [3, jobFailed("run-1", "cancelled")],
      ],
      runs: ["A#1 opened done/cancelled (worker_failed)"],
      effects: [
        ["check run-1 queued", "comment 7"],
        ["check run-1 in_progress", "spawn run-1", "comment 7"],
        ["check run-1 completed cancelled", "comment 7"],
      ],
    },
    {
      name: "a job event for a run that's no longer verifying changes nothing",
      steps: [
        [0, opened("A")],
        [1, preview("A")],
        [2, pushed("B")],
        [3, jobFinished("run-1")],
      ],
      runs: ["A#1 opened done/superseded", "B#1 synchronize waiting_inputs"],
      effects: [
        ["check run-1 queued", "comment 7"],
        ["check run-1 in_progress", "spawn run-1", "comment 7"],
        ["cancel run-1", "check run-1 completed neutral", "check run-2 queued", "comment 7"],
        [],
      ],
    },
  ])("$name", ({ steps, runs, effects }) => {
    const result = simulate(steps);
    expect(result.summaries).toEqual(runs);
    expect(result.effects).toEqual(effects);
  });

  it("records the preview URL, the start and a 15-minute deadline on a run that starts verifying", () => {
    const { runs } = simulate([
      [0, opened("A")],
      [3, preview("A")],
    ]);
    expect(runs[0]).toMatchObject({
      prUrl: urlOf("A"),
      createdAt: at(0),
      startedAt: at(3),
      deadlineAt: new Date(at(3).getTime() + VERIFY_DEADLINE_MS),
      finishedAt: null,
    });
  });

  it("times a run's wait from its creation, and records when it gave up", () => {
    const { runs } = simulate([
      [5, opened("A")],
      [5 + PREVIEW_WAIT_MS / 60_000 - 1, tick],
      [5 + PREVIEW_WAIT_MS / 60_000, tick],
    ]);
    expect(runs[0]).toMatchObject({ state: "done", finishedAt: at(25) });
  });

  it("closes an inconclusive run's check as the repo's policy says (§22.5)", () => {
    const { effects } = simulate(
      [
        [0, opened("A")],
        [20, tick],
      ],
      "failure",
    );
    expect(effects[1]).toEqual(["check run-1 completed failure", "comment 7"]);
  });
});

describe("transition", () => {
  const done: Run = {
    id: "run-1",
    headSha: "A",
    attemptNo: 1,
    trigger: "opened",
    state: "done",
    outcome: "pass",
    outcomeReason: null,
    prUrl: urlOf("A"),
    createdAt: at(0),
    startedAt: at(1),
    deadlineAt: at(16),
    finishedAt: at(4),
  };

  it.each([
    { kind: "start", url: urlOf("A") },
    { kind: "supersede" },
    { kind: "finish", outcome: "error", reason: "deadline_passed" },
  ] as const)("leaves a done run alone: $kind", (step) => {
    const next = transition(done, step, at(30), "neutral");
    expect(next.run).toBe(done);
    expect(next.effects).toEqual([]);
  });

  it("doesn't restart a run that is already verifying", () => {
    const verifying: Run = { ...done, state: "verifying", outcome: null, finishedAt: null };
    const next = transition(verifying, { kind: "start", url: "https://other" }, at(5), "neutral");
    expect(next.run).toBe(verifying);
    expect(next.effects).toEqual([]);
  });
});

describe("conclusionFor", () => {
  it.each([
    ["pass", "neutral", "success"],
    ["fail", "neutral", "failure"],
    ["inconclusive", "neutral", "neutral"],
    ["inconclusive", "failure", "failure"],
    ["error", "failure", "neutral"],
    ["cancelled", "neutral", "cancelled"],
    ["superseded", "failure", "neutral"],
  ] as const)("%s with policy %s → %s", (outcome, policy, conclusion) => {
    expect(conclusionFor(outcome, policy)).toBe(conclusion);
  });
});
