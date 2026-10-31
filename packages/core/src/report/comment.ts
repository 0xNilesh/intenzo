// The PR comment (§26.1): one per run group, rebuilt from the database on every change. It shows
// the latest run that wasn't superseded, with a row per criterion, and links each clip to the
// report page, where the videos play.
import { formatDuration } from "./duration.ts";
import { aggregate, type ReportCriterion, type ReportModel } from "./model.ts";

/** GitHub refuses comment bodies longer than this. */
export const MAX_COMMENT_CHARS = 65_536;
const CUT_NOTE = "\n\n…cut to fit GitHub's limit: the full report has everything.";

/** Starts the group's comment, so it can be found again if its id was never saved. */
export const commentMarker = (groupId: number) => `<!-- intenzo:run-group:${groupId} -->`;

const ICON = { pass: "✅", fail: "❌", inconclusive: "⚠️" } as const;

/**
 * Untrusted text (ticket, judges) for a table cell or a line: one line, no table pipes, no HTML,
 * and no @mentions that would notify people.
 */
export function cell(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return cut
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replaceAll("@", "@​");
}

const short = (sha: string) => sha.slice(0, 7);

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "❌ 3/4 passed", "⏳ waiting for the preview", "⏭ superseded"… */
export function statusLine(model: ReportModel): string {
  const { run, criteria } = model;
  const n = criteria.length;
  const passed = criteria.filter((c) => c.verdict === "pass").length;
  if (run.state === "waiting_inputs") return "⏳ waiting for the preview";
  if (run.state !== "done") {
    const judged = criteria.filter((c) => c.verdict !== null).length;
    return n > 0 ? `🔎 verifying · ${judged}/${n} judged` : "🔎 verifying";
  }
  switch (run.outcome) {
    case "pass":
    case "fail":
    case "inconclusive": {
      const overall = n > 0 ? aggregate(criteria.map((c) => c.verdict)) : null;
      if (overall === null)
        return run.outcome === "inconclusive"
          ? "⚠️ not verified"
          : `${ICON[run.outcome]} ${run.outcome}`;
      if (overall === "pass") return `✅ ${n}/${n} passed`;
      const unsure = criteria.filter((c) => c.verdict === "inconclusive").length;
      return overall === "fail"
        ? `❌ ${passed}/${n} passed`
        : `⚠️ ${passed}/${n} passed · ${unsure} inconclusive`;
    }
    case "superseded":
      return "⏭ superseded";
    case "error":
      return "💥 Intenzo failed";
    case "cancelled":
      return "⏹ cancelled";
    case null:
      return "done";
  }
}

/** Why a run ended without verdicts, or what it's doing, in a sentence. */
function stateSentence(model: ReportModel): string | null {
  const { run } = model;
  const at = `\`${short(run.headSha)}\``;
  if (run.state === "waiting_inputs") return `Waiting for the preview of ${at}.`;
  if (run.state !== "done")
    return model.criteria.length > 0 ? null : `Verifying ${at} on its preview.`;
  if (model.criteria.length > 0) return null;
  switch (run.outcomeReason) {
    case "preview_not_ready":
      return `${at} wasn't verified: its preview wasn't ready within 20 minutes.`;
    case "preview_failed":
      return `${at} wasn't verified: its preview failed to deploy.`;
    case "deadline_passed":
      return `Verifying ${at} took longer than 15 minutes and was stopped.`;
    case "worker_failed":
      return run.outcome === "cancelled"
        ? `Verifying ${at} was cancelled.`
        : `Intenzo failed while verifying ${at}.`;
  }
  if (run.outcome === "superseded") return `${at} was superseded by a newer commit.`;
  return null;
}

function criterionRows(c: ReportCriterion, reportUrl: string): string[] {
  const icon = c.verdict ? ICON[c.verdict] : "⏳";
  const evidence = c.clip
    ? `[▶ ${clock(c.clip.startMs)}–${clock(c.clip.endMs)}](${reportUrl}#${c.id})`
    : c.verdict
      ? `[report](${reportUrl}#${c.id})`
      : "";
  const rows = [`| ${icon} | **${c.id}** ${cell(c.text)} | ${evidence} |`];
  if (c.verdict === "fail" || c.verdict === "inconclusive") {
    const parts = [`Expected: ${cell(c.expected)}`];
    if (c.observed) parts.push(`Observed: ${cell(c.observed, 500)}`);
    if (c.verdict === "inconclusive" && c.reasonCode)
      parts.push(`(${c.reasonCode.replaceAll("_", " ")})`);
    rows.push(`| | ${parts.join(" · ")} | |`);
  }
  return rows;
}

/** The part both the comment and the check run show: the table, or a sentence, and the footer. */
export function reportBody(model: ReportModel): string {
  const { run, criteria } = model;
  const lines: string[] = [];
  const sentence = stateSentence(model);
  if (sentence) lines.push(sentence, "");
  if (criteria.length > 0) {
    lines.push("| | Criterion | Evidence |", "|---|---|---|");
    for (const c of criteria) lines.push(...criterionRows(c, model.reportUrl));
    lines.push("");
  }

  // Baseline, judges and the report only mean something once the run is verifying or has verdicts.
  const started = criteria.length > 0 || run.state === "verifying" || run.state === "reporting";
  const facts: string[] = [];
  if (started) {
    const b = run.baseline;
    facts.push(
      b === null
        ? "Baseline: none"
        : `Baseline: \`${short(b.sha)}\` (${b.drift === 0 ? "the merge base" : `${b.drift} commit${b.drift === 1 ? "" : "s"} before the merge base`})`,
    );
  }
  if (started && run.judges.length > 0)
    facts.push(`Judges: ${run.judges.map((j) => cell(j, 60)).join(" + ")}`);
  // Blank lines between them: the Checks tab doesn't turn a single newline into a break.
  if (facts.length > 0) lines.push(facts.join(" · "), "");
  if (run.outcome === "inconclusive" && criteria.length > 0) {
    lines.push(
      `Inconclusive is reported as **${model.policy.inconclusive}** here (\`policy.inconclusive_conclusion\`).`,
      "",
    );
  }
  const totals: string[] = [];
  if (run.durationMs !== null) totals.push(`⏱ ${formatDuration(run.durationMs)}`);
  if (run.costUsd !== null) totals.push(`💲 $${run.costUsd.toFixed(2)}`);
  if (started) totals.push(`[Full report](${model.reportUrl})`);
  if (totals.length > 0) lines.push(totals.join(" · "));
  return lines.join("\n").trim();
}

/** Sections a reader opens; the first to go when the comment is too long. */
function collapsedSections(model: ReportModel): string[] {
  const sections: string[] = [];
  const read = model.criteria.filter((c) => c.readings);
  if (read.length > 0) {
    const items = read.map((c) => `- **${c.id}** ${cell(c.readings!, 2000)}`);
    sections.push(`<details><summary>Readings</summary>\n\n${items.join("\n")}\n</details>`);
  }
  if (model.history.length > 0) {
    const items = model.history.map(
      (h) => `- \`${short(h.headSha)}\` attempt ${h.attemptNo}: ${h.outcome ?? "running"}`,
    );
    sections.push(
      `<details><summary>Earlier runs (${model.history.length})</summary>\n\n${items.join("\n")}\n</details>`,
    );
  }
  return sections;
}

export function renderComment(model: ReportModel): string {
  const ticket = model.ticket
    ? ` · verified against ${cell(model.ticket.ref, 100)} "${cell(model.ticket.title, 120)}"`
    : "";
  const heading = `### Intenzo${ticket} · ${statusLine(model)} · attempt ${model.run.attemptNo}`;
  const main = `${commentMarker(model.groupId)}\n${heading}\n\n${reportBody(model)}`;
  const sections = collapsedSections(model);
  const assemble = () => [main, ...sections].join("\n\n") + "\n";
  // §26.1: under GitHub's limit, collapsed sections go first, the last one first.
  let text = assemble();
  while (text.length > MAX_COMMENT_CHARS && sections.length > 0) {
    sections.pop();
    text = assemble();
  }
  return text.length > MAX_COMMENT_CHARS
    ? text.slice(0, MAX_COMMENT_CHARS - CUT_NOTE.length) + CUT_NOTE
    : text;
}
