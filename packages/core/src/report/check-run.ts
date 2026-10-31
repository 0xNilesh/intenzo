// The Intenzo check run (§26.2): the same table as the comment, the conclusion §22.5 gives the run's
// outcome, and, once completed, the buttons its outcome allows.
import { reportBody, statusLine } from "./comment.ts";
import { type CheckConclusion, conclusionFor, type ReportModel } from "./model.ts";

/** GitHub's limits: summary 65,535 characters; at most 3 actions, label ≤ 20, description ≤ 40. */
const MAX_SUMMARY_CHARS = 65_535;

export interface CheckRunAction {
  label: string;
  description: string;
  identifier: string;
}

export interface CheckRunPayload {
  status: "queued" | "in_progress" | "completed";
  conclusion?: CheckConclusion;
  /** GitHub's "Details" link: without one it opens the App's homepage. */
  detailsUrl: string;
  output: { title: string; summary: string };
  actions: CheckRunAction[];
}

export const ACTIONS = {
  approve: { label: "Approve (PM)", description: "Record product approval", identifier: "approve" },
  rerun: { label: "Re-run", description: "Verify this commit again", identifier: "rerun" },
  fix: { label: "Send to agent", description: "Ask the fixer agent for a fix", identifier: "fix" },
} as const satisfies Record<string, CheckRunAction>;

/**
 * §26.2: pass → Approve (PM), Re-run; fail → Send to agent (when an agent is configured), Re-run;
 * inconclusive → Re-run. Approve is never offered on a failing run, and nothing is offered before
 * the run completes (the buttons can be pressed on a running check, T0.4).
 */
export function actionsFor(model: ReportModel): CheckRunAction[] {
  if (model.run.state !== "done") return [];
  switch (model.run.outcome) {
    case "pass":
      return [ACTIONS.approve, ACTIONS.rerun];
    case "fail":
      return model.policy.agentHandle ? [ACTIONS.fix, ACTIONS.rerun] : [ACTIONS.rerun];
    case "inconclusive":
      return [ACTIONS.rerun];
    default:
      return [];
  }
}

export function checkRunPayload(model: ReportModel): CheckRunPayload {
  const { run } = model;
  const summary = reportBody(model);
  const output = {
    // The status line without its icon: "3/4 passed", "waiting for the preview".
    title: statusLine(model)
      .replace(/^\S+\s/, "")
      .replace(/^./, (c) => c.toUpperCase()),
    summary:
      summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…` : summary,
  };
  const detailsUrl = model.reportUrl;
  if (run.state !== "done") {
    return {
      status: run.state === "waiting_inputs" ? "queued" : "in_progress",
      detailsUrl,
      output,
      actions: [],
    };
  }
  return {
    status: "completed",
    conclusion: conclusionFor(run.outcome ?? "superseded", model.policy.inconclusive),
    detailsUrl,
    output,
    actions: actionsFor(model),
  };
}
