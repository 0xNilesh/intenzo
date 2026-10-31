// The run state machine (§16) as pure functions, so every rule is a table-driven test. The
// database layer loads a run group, asks decide() what a fact changes, and writes the changed runs
// and their effects in one transaction (§16.4; the effects become outbox rows in T2.4).
import type { RunOutcome } from "@intenzo/core";

export type RunState = "waiting_inputs" | "verifying" | "reporting" | "done";

/** What created a run: a pull_request action (§17), or a late preview re-opening it (§16.2). */
export type RunTrigger =
  "opened" | "reopened" | "ready_for_review" | "synchronize" | "late_preview";

/** Why a run ended without verdicts. */
export type OutcomeReason =
  "preview_not_ready" | "preview_failed" | "deadline_passed" | "worker_failed";

/** §16.1: how long a run waits for its preview. */
export const PREVIEW_WAIT_MS = 20 * 60_000;
/** §16.2: a preview arriving this soon after a run timed out re-opens it, as attempt n+1. */
export const REOPEN_WINDOW_MS = 2 * 60 * 60_000;
/** §16.1: a verifying run's deadline_at. */
export const VERIFY_DEADLINE_MS = 15 * 60_000;

export interface Run {
  id: string;
  headSha: string;
  /** Counts from 1 per head SHA (§16.3). */
  attemptNo: number;
  trigger: RunTrigger;
  state: RunState;
  /** Set exactly when the run is done (§16.1). */
  outcome: RunOutcome | null;
  outcomeReason: OutcomeReason | null;
  /** The PR preview's URL, once its deployment is known. */
  prUrl: string | null;
  createdAt: Date;
  startedAt: Date | null;
  deadlineAt: Date | null;
  finishedAt: Date | null;
}

/** What decide() needs to know about one pull request's run group. */
export interface Group {
  id: number;
  runs: readonly Run[];
  /**
   * Successful non-production previews known for the group's commits, by SHA: the deployments
   * table, backfilled once from GitHub's API when a run is created (§16.2).
   */
  previews: ReadonlyMap<string, string>;
  /** The repo's policy.inconclusive_conclusion (§22.5). */
  inconclusiveConclusion: "neutral" | "failure";
}

/** Something that happened to the group, already filtered by the webhook handlers (§17). */
export type Fact =
  /** pull_request opened, reopened or ready_for_review. Drafts never run. */
  | {
      kind: "pr_ready";
      trigger: "opened" | "reopened" | "ready_for_review";
      headSha: string;
      draft: boolean;
    }
  /** pull_request.synchronize: a new head commit. */
  | { kind: "pr_pushed"; headSha: string; draft: boolean }
  /** A successful deployment_status for a matching, non-production environment (§17.1). */
  | { kind: "preview_ready"; sha: string; url: string }
  /** A failed deployment_status. */
  | { kind: "preview_failed"; sha: string }
  /** The sweeper's minute tick: deadlines (§16.1). */
  | { kind: "tick" }
  /** The run's current job reported `finished` (§9). Its events were already checked as current. */
  | { kind: "job_finished"; runId: string; outcome: RunOutcome }
  /** The run's current job reported `failed`, with its error code (§9; the shim's `cancelled`, …). */
  | { kind: "job_failed"; runId: string; code: string };

export type CheckConclusion = "success" | "failure" | "neutral" | "cancelled";

export type Effect =
  /** The run's `Intenzo` check run should now look like this (§26.2). */
  | {
      kind: "check_run";
      runId: string;
      status: "queued" | "in_progress" | "completed";
      conclusion?: CheckConclusion;
    }
  /** Re-render the group's one comment from the database (§26.1). */
  | { kind: "comment"; groupId: number }
  | { kind: "spawn_job"; runId: string }
  | { kind: "cancel_job"; runId: string };

export interface Decision {
  /** Runs to insert, already in their state after the fact. */
  created: Run[];
  /** Existing runs that changed, in their new state. */
  updated: Run[];
  effects: Effect[];
}

export interface Clock {
  now: Date;
  /** Ids for new runs: random UUIDs in production, predictable ones in tests. */
  newRunId: () => string;
}

/** One change to one run. */
export type Step =
  | { kind: "start"; url: string }
  | { kind: "supersede" }
  | {
      kind: "finish";
      outcome: RunOutcome;
      reason: OutcomeReason | null;
      /** The job ended by itself, so there's nothing to cancel. */
      jobEnded?: boolean;
    };

/** Applies one step to one run. A run that is done never changes again. */
export function transition(
  run: Run,
  step: Step,
  now: Date,
  inconclusive: Group["inconclusiveConclusion"],
): { run: Run; effects: Effect[] } {
  if (run.state === "done") return { run, effects: [] };
  switch (step.kind) {
    case "start":
      if (run.state !== "waiting_inputs") return { run, effects: [] };
      return {
        run: {
          ...run,
          state: "verifying",
          prUrl: step.url,
          startedAt: now,
          deadlineAt: new Date(now.getTime() + VERIFY_DEADLINE_MS),
        },
        effects: [
          { kind: "check_run", runId: run.id, status: "in_progress" },
          { kind: "spawn_job", runId: run.id },
        ],
      };
    case "supersede":
      return finish(run, "superseded", null, now, inconclusive, false);
    case "finish":
      return finish(run, step.outcome, step.reason, now, inconclusive, step.jobEnded ?? false);
  }
}

function finish(
  run: Run,
  outcome: RunOutcome,
  reason: OutcomeReason | null,
  now: Date,
  inconclusive: Group["inconclusiveConclusion"],
  jobEnded: boolean,
): { run: Run; effects: Effect[] } {
  const effects: Effect[] = [];
  // §16.3: a job that may still be running is told to stop.
  if (run.state === "verifying" && !jobEnded) effects.push({ kind: "cancel_job", runId: run.id });
  effects.push({
    kind: "check_run",
    runId: run.id,
    status: "completed",
    conclusion: conclusionFor(outcome, inconclusive),
  });
  return {
    run: { ...run, state: "done", outcome, outcomeReason: reason, finishedAt: now },
    effects,
  };
}

/** §22.5, plus: Intenzo's own errors never block a merge, and a superseded run is neutral (§16.3). */
export function conclusionFor(
  outcome: RunOutcome,
  inconclusive: Group["inconclusiveConclusion"],
): CheckConclusion {
  switch (outcome) {
    case "pass":
      return "success";
    case "fail":
      return "failure";
    case "inconclusive":
      return inconclusive;
    case "cancelled":
      return "cancelled";
    case "error":
    case "superseded":
      return "neutral";
  }
}

/** What one fact changes in a group: runs to create, runs that change, and the effects. */
export function decide(group: Group, fact: Fact, clock: Clock): Decision {
  const { now } = clock;
  const created: Run[] = [];
  const updated: Run[] = [];
  const effects: Effect[] = [];

  const apply = (run: Run, step: Step) => {
    const next = transition(run, step, now, group.inconclusiveConclusion);
    if (next.run !== run) updated.push(next.run);
    effects.push(...next.effects);
  };
  // §16.2: a new run looks its preview up straight away and verifies at once if it's there.
  const open = (headSha: string, trigger: RunTrigger) => {
    const attempts = group.runs.filter((r) => r.headSha === headSha).map((r) => r.attemptNo);
    const run: Run = {
      id: clock.newRunId(),
      headSha,
      attemptNo: Math.max(0, ...attempts) + 1,
      trigger,
      state: "waiting_inputs",
      outcome: null,
      outcomeReason: null,
      prUrl: null,
      createdAt: now,
      startedAt: null,
      deadlineAt: null,
      finishedAt: null,
    };
    const url = group.previews.get(headSha);
    if (url === undefined) {
      created.push(run);
      effects.push({ kind: "check_run", runId: run.id, status: "queued" });
      return;
    }
    const started = transition(run, { kind: "start", url }, now, group.inconclusiveConclusion);
    created.push(started.run);
    effects.push(...started.effects);
  };

  // At most one run per group isn't done: each new run supersedes the one before (§16.3).
  const active = group.runs.find((r) => r.state !== "done");
  switch (fact.kind) {
    case "pr_ready":
      if (fact.draft || active?.headSha === fact.headSha) break;
      if (active) apply(active, { kind: "supersede" });
      open(fact.headSha, fact.trigger);
      break;
    case "pr_pushed":
      if (active?.headSha === fact.headSha) break;
      if (active) apply(active, { kind: "supersede" });
      if (!fact.draft) open(fact.headSha, "synchronize");
      break;
    case "preview_ready": {
      const waiting = group.runs.find(
        (r) => r.state === "waiting_inputs" && r.headSha === fact.sha,
      );
      if (waiting) {
        apply(waiting, { kind: "start", url: fact.url });
        break;
      }
      // §16.2: a preview for a run that gave up waiting within the last 2 h re-opens it.
      const latest = group.runs.reduce<Run | undefined>(
        (a, r) => (a && a.createdAt >= r.createdAt ? a : r),
        undefined,
      );
      if (
        !active &&
        latest?.headSha === fact.sha &&
        latest.outcomeReason === "preview_not_ready" &&
        latest.finishedAt &&
        now.getTime() - latest.finishedAt.getTime() <= REOPEN_WINDOW_MS
      ) {
        open(fact.sha, "late_preview");
      }
      break;
    }
    case "preview_failed": {
      const waiting = group.runs.find(
        (r) => r.state === "waiting_inputs" && r.headSha === fact.sha,
      );
      if (waiting) {
        apply(waiting, { kind: "finish", outcome: "inconclusive", reason: "preview_failed" });
      }
      break;
    }
    case "tick":
      for (const run of group.runs) {
        const waited = now.getTime() - run.createdAt.getTime();
        if (
          run.state === "waiting_inputs" &&
          !group.previews.has(run.headSha) &&
          waited >= PREVIEW_WAIT_MS
        ) {
          apply(run, { kind: "finish", outcome: "inconclusive", reason: "preview_not_ready" });
        } else if (run.state === "verifying" && run.deadlineAt && now >= run.deadlineAt) {
          apply(run, { kind: "finish", outcome: "error", reason: "deadline_passed" });
        }
      }
      break;
    case "job_finished":
    case "job_failed": {
      const run = group.runs.find((r) => r.id === fact.runId);
      if (run?.state !== "verifying" && run?.state !== "reporting") break;
      apply(
        run,
        fact.kind === "job_finished"
          ? { kind: "finish", outcome: fact.outcome, reason: null, jobEnded: true }
          : {
              kind: "finish",
              outcome: fact.code === "cancelled" ? "cancelled" : "error",
              reason: "worker_failed",
              jobEnded: true,
            },
      );
      break;
    }
  }

  if (created.length > 0 || updated.length > 0)
    effects.push({ kind: "comment", groupId: group.id });
  return { created, updated, effects };
}
