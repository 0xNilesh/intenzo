// What the check run and the comment say, rendered from the database when the effect runs (§16.4),
// never from the effect's payload, so whichever drainer runs last shows the latest state. A status
// line per run for now; T2.7's report renderer (core/report) replaces it with the full report.
import type { runGroups, runs } from "../db/schema.ts";
import { type CheckConclusion, conclusionFor } from "../runs/transition.ts";

type RunRow = typeof runs.$inferSelect;
type GroupRow = typeof runGroups.$inferSelect;

/** Starts the group's comment, so it can be found again if its id was never saved. */
export const commentMarker = (groupId: number) => `<!-- intenzo:run-group:${groupId} -->`;

const short = (sha: string) => sha.slice(0, 7);

function headline(run: RunRow): { title: string; detail: string } {
  const at = `\`${short(run.headSha)}\`${run.attemptNo > 1 ? ` (attempt ${run.attemptNo})` : ""}`;
  switch (run.state) {
    case "waiting_inputs":
      return { title: "Waiting for the preview", detail: `⏳ Waiting for the preview of ${at}.` };
    case "verifying": {
      const baseline =
        run.baseUrl && run.baseSha
          ? `\`${short(run.baseSha)}\` (${run.baseDrift ? `${run.baseDrift} commit${run.baseDrift === 1 ? "" : "s"} before the merge base` : "the merge base"})`
          : "none";
      return {
        title: "Verifying the preview",
        detail: `🔎 Verifying ${at} on [its preview](${run.prUrl}). Baseline: ${baseline}.`,
      };
    }
    case "reporting":
      return { title: "Writing the report", detail: `📝 Writing the report for ${at}.` };
    case "done":
      return finished(run, at);
  }
}

function finished(run: RunRow, at: string): { title: string; detail: string } {
  switch (run.outcome) {
    case "pass":
      return { title: "Verified", detail: `✅ ${at} does what the ticket asks.` };
    case "fail":
      return { title: "Not verified", detail: `❌ ${at} doesn't do everything the ticket asks.` };
    case "inconclusive": {
      const why =
        run.outcomeReason === "preview_not_ready"
          ? "its preview wasn't ready within 20 minutes"
          : run.outcomeReason === "preview_failed"
            ? "its preview failed to deploy"
            : "Intenzo couldn't tell";
      return { title: "Inconclusive", detail: `⚠️ ${at} wasn't verified: ${why}.` };
    }
    case "error":
      return {
        title: "Intenzo failed",
        detail:
          run.outcomeReason === "deadline_passed"
            ? `💥 Verifying ${at} took longer than 15 minutes and was stopped.`
            : `💥 Intenzo failed while verifying ${at}.`,
      };
    case "cancelled":
      return { title: "Cancelled", detail: `⏹ Verifying ${at} was cancelled.` };
    case "superseded":
    case null:
      return { title: "Superseded", detail: `⏭ ${at} was superseded by a newer commit.` };
  }
}

export interface CheckRunFields {
  status: "queued" | "in_progress" | "completed";
  conclusion?: CheckConclusion;
  started_at?: string;
  completed_at?: string;
  output: { title: string; summary: string };
}

/** The check run for one run (§26.2): docs.github.com/en/rest/checks/runs */
export function checkRunFields(run: RunRow, inconclusive: "neutral" | "failure"): CheckRunFields {
  const { title, detail } = headline(run);
  const output = { title, summary: detail };
  const started = run.startedAt ? { started_at: run.startedAt.toISOString() } : {};
  if (run.state === "done") {
    return {
      status: "completed",
      conclusion: conclusionFor(run.outcome ?? "superseded", inconclusive),
      ...started,
      completed_at: (run.finishedAt ?? new Date()).toISOString(),
      output,
    };
  }
  return { status: run.state === "waiting_inputs" ? "queued" : "in_progress", ...started, output };
}

/**
 * The group's one comment (§26.1): the latest run that wasn't superseded, or the latest run when
 * every one was (§16.4).
 */
export function commentBody(group: GroupRow, groupRuns: readonly RunRow[]): string {
  const latest = [...groupRuns].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const shown = latest.find((r) => r.outcome !== "superseded") ?? latest[0];
  const status = shown ? headline(shown).detail : "⏳ Waiting for a commit to verify.";
  return `${commentMarker(group.id)}\n### Intenzo\n\n${status}\n`;
}
