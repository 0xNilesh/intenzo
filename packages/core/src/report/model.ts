// What a report says (§26): built by the Cloud from its database, rendered here into the PR comment
// and the check run, so both always show the same state.
import type { ReasonCode, RunOutcome, VerdictValue } from "../schema/verdict.ts";

export interface ReportCriterion {
  id: string;
  text: string;
  expected: string;
  /** Null until the criterion is judged. */
  verdict: VerdictValue | null;
  reasonCode: ReasonCode | null;
  /** What the judges saw, in a sentence. */
  observed: string | null;
  /** The evidence window in the PR side's human video, ms from its start. */
  clip: { startMs: number; endMs: number } | null;
  /** The evidence GIF's public URL (§23), shown inline for a failed or visual criterion (§26.1). */
  gif?: string | null;
  /** A ui_visual criterion: its evidence is the picture (SAM's highlight, T5.2), pass or fail. */
  visual?: boolean;
  /** The readings behind the verdict, one line: "+0 s $50.00 · +1 s $50.00 · after reload $45.00". */
  readings: string | null;
}

export interface ReportRun {
  id: string;
  headSha: string;
  attemptNo: number;
  state: "waiting_inputs" | "verifying" | "reporting" | "done";
  outcome: RunOutcome | null;
  /** Why a run ended without verdicts: preview_not_ready, preview_failed, deadline_passed, worker_failed. */
  outcomeReason: string | null;
  baseline: { sha: string; drift: number } | null;
  /** The models whose verdicts the run used, e.g. ["Spark Open", "Spark 1.3"]. */
  judges: string[];
  durationMs: number | null;
  costUsd: number | null;
}

export interface ReportModel {
  /** The run group: the comment's marker carries it. */
  groupId: number;
  ticket: { ref: string; title: string } | null;
  run: ReportRun;
  criteria: ReportCriterion[];
  /** The run's report page, where the videos play. */
  reportUrl: string;
  /** The group's earlier runs, newest first. */
  history: { headSha: string; attemptNo: number; outcome: RunOutcome | null }[];
  policy: { inconclusive: "neutral" | "failure"; agentHandle: string | null };
}

export type CheckConclusion = "success" | "failure" | "neutral" | "cancelled";

/** §22.5: pass succeeds, fail fails, inconclusive follows the policy, Intenzo's own failures never block. */
export function conclusionFor(
  outcome: RunOutcome,
  inconclusive: "neutral" | "failure",
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

/** §22.4: any fail fails, else any inconclusive is inconclusive, else pass. Null while unjudged. */
export function aggregate(verdicts: readonly (VerdictValue | null)[]): VerdictValue | null {
  if (verdicts.length === 0 || verdicts.includes(null)) return null;
  if (verdicts.includes("fail")) return "fail";
  if (verdicts.includes("inconclusive")) return "inconclusive";
  return "pass";
}
