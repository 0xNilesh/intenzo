// The Phase 5 gate's checks (ROADMAP P5 gate, #47) on one full loop, from what GitHub and the Cloud
// show: the almost-right PR's first run (the golden comment's verdicts, the total's GIF, the
// chart's SAM GIF, the ⚠️ line), the fix request and the fixer's commit with CI on it, the run
// after it (all ✅), and the PM's approval with the merge allowed.
import { type About, aboutOf, goldenProblems, readRows } from "./p4.ts";

/** The golden comment's unrequested change (demo/expected-comment.md). */
export const UNREQUESTED = '⚠️ Unrequested change on /cart: link "Checkout" → "Continue"';
/** An evidence GIF shown inline (§26.1, T5.1–T5.2). */
const INLINE_GIF = /!\[C\d+\]\(https:\/\/[^)\s]+\/evidence\.gif\)/;
const ROW = /^\| (?:✅|❌|⚪|⏳) \| \*\*C\d+\*\* (.*?) \| (.*) \|$/;

/** Each criterion's evidence cell, by what the criterion is about. */
export function evidenceCells(summary: string): Partial<Record<About, string>> {
  const cells: Partial<Record<About, string>> = {};
  for (const line of summary.split("\n")) {
    const row = ROW.exec(line);
    const about = row && aboutOf(row[1]!);
    if (about) cells[about] = row[2]!;
  }
  return cells;
}

/** What's missing from the almost-right PR's first run (P5 gate, step 1). */
export function failedRunProblems(title: string, summary: string): string[] {
  const problems = goldenProblems("almost-right", title, readRows(summary));
  const cells = evidenceCells(summary);
  if (!INLINE_GIF.test(cells.total ?? "")) problems.push("the total's GIF isn't inline");
  if (!INLINE_GIF.test(cells.chart ?? "")) problems.push("the chart's SAM GIF isn't inline");
  if (!summary.includes(UNREQUESTED)) problems.push(`no "${UNREQUESTED}"`);
  return problems;
}

/** What's missing from the run on the fixer's commit (step 3): every criterion ✅. */
export function passedRunProblems(title: string, summary: string): string[] {
  return goldenProblems("correct", title, readRows(summary));
}

export interface Loop {
  fixRequests: number;
  /** The fixer's commit, and the conclusion of the repo's CI on it. */
  fixer: { sha: string; ci: string | null } | null;
  /** The commit status on the passing run's commit. */
  approval: { state: string; description: string } | null;
  mergeableState: string | null;
  required: readonly string[];
}

/** Steps 2 and 4: the request, the fixer's commit with CI passing, the approval, the merge allowed. */
export function loopProblems(loop: Loop): string[] {
  const problems: string[] = [];
  if (loop.fixRequests !== 1) problems.push(`${loop.fixRequests} fix requests, not 1`);
  if (!loop.fixer) problems.push("no commit by intenzo-fixer[bot]");
  else if (loop.fixer.ci !== "success")
    problems.push(`CI on the fixer's commit: ${loop.fixer.ci ?? "none"}`);
  if (loop.approval?.state !== "success") problems.push("no product approval");
  if (!loop.required.includes("Intenzo / product approval"))
    problems.push("main doesn't require the product approval");
  if (loop.mergeableState !== "clean") problems.push(`merge state "${loop.mergeableState}"`);
  return problems;
}
