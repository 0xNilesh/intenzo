// The Phase 4 gate's checks on a hosted run's report (ROADMAP P4 gate): its check run's summary
// is the comment's table (§26.2), read here row by row. The golden comment
// (demo/expected-comment.md) is matched by what each criterion is about, not by its number: the
// PM's recording says the total first, so the intent step numbers it C1 (DECISIONS 2026-10-31 ·
// Intent from the PM video).

export type About = "total" | "line" | "expired" | "chart";
export type Icon = "pass" | "fail" | "inconclusive" | "pending";

export interface Row {
  id: string;
  text: string;
  verdict: Icon;
  /** The row's detail: "Readings: …" from a failed or inconclusive row (§26.1). */
  readings: string | null;
}

const ICONS: Record<string, Icon> = {
  "✅": "pass",
  "❌": "fail",
  "⚪": "inconclusive",
  "⏳": "pending",
};

/** The criterion rows of a report's table, each with its detail row's readings. */
export function readRows(summary: string): Row[] {
  const rows: Row[] = [];
  for (const line of summary.split("\n")) {
    const head = /^\| (✅|❌|⚪|⏳) \| \*\*(C\d+)\*\* (.*?) \|/.exec(line);
    if (head) {
      rows.push({ id: head[2]!, text: head[3]!, verdict: ICONS[head[1]!]!, readings: null });
      continue;
    }
    const detail = /^\| \| (.*) \| \|$/.exec(line);
    const readings = detail && /Readings: (.*?)(?: · Observed:| · \(|$)/.exec(detail[1]!);
    if (readings && rows.length > 0) rows.at(-1)!.readings = readings[1]!;
  }
  return rows;
}

/** Which of the demo's four criteria a row is about, from its words. */
export function aboutOf(text: string): About | null {
  if (/expired|OLD5/i.test(text)) return "expired";
  if (/chart|slice/i.test(text)) return "chart";
  if (/own line|line in the|discount line|−\$?5|-\$?5\b|minus \$?5/i.test(text)) return "line";
  if (/total|\$45/i.test(text)) return "total";
  return null;
}

/** The golden comment's verdicts, by what each criterion is about. */
export const GOLDEN: Record<
  "almost-right" | "correct",
  { outcome: string; verdicts: Record<About, Icon> }
> = {
  "almost-right": {
    outcome: "3/4 passed",
    verdicts: { total: "fail", line: "pass", expired: "pass", chart: "pass" },
  },
  correct: {
    outcome: "4/4 passed",
    verdicts: { total: "pass", line: "pass", expired: "pass", chart: "pass" },
  },
};

/** The golden C2 readings, as far as the criterion read from the video asks (no reload probe). */
export const GOLDEN_TOTAL_READINGS = "+0 s $50.00 · +1 s $50.00 · +3 s $50.00";

/** What differs from the golden comment in one run's report; empty when it matches. */
export function goldenProblems(
  code: keyof typeof GOLDEN,
  title: string,
  rows: readonly Row[],
): string[] {
  const want = GOLDEN[code];
  const problems: string[] = [];
  if (title !== want.outcome) problems.push(`outcome "${title}", not "${want.outcome}"`);
  const seen = new Map<About, Row>();
  for (const row of rows) {
    const about = aboutOf(row.text);
    if (!about) problems.push(`${row.id} isn't one of the demo's criteria: ${row.text}`);
    else if (seen.has(about))
      problems.push(`${row.id} and ${seen.get(about)!.id} are both about the ${about}`);
    else seen.set(about, row);
  }
  for (const [about, verdict] of Object.entries(want.verdicts) as [About, Icon][]) {
    const row = seen.get(about);
    if (!row) problems.push(`no criterion about the ${about}`);
    else if (row.verdict !== verdict)
      problems.push(`the ${about} (${row.id}) is ${row.verdict}, not ${verdict}`);
  }
  const total = seen.get("total");
  if (code === "almost-right" && total && !total.readings?.startsWith(GOLDEN_TOTAL_READINGS)) {
    problems.push(`the total's readings are "${total.readings}", not "${GOLDEN_TOTAL_READINGS}…"`);
  }
  return problems;
}
