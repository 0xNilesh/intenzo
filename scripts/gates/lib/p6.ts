// The Phase 6 gate's checks (ROADMAP P6 gate): IntentBench's held-out results are complete for
// every arm with a spread, and the README carries their table with the small-n caveat.

export const ARMS = ["A", "B", "C", "D"] as const;
/** Arm D gives the dual verdict and each model's own. */
const JUDGES: Record<(typeof ARMS)[number], readonly string[]> = {
  A: ["spark-1.3"],
  B: ["spark-1.3"],
  C: ["spark-1.3"],
  D: ["dual", "spark-open", "spark-1.3"],
};

interface Row {
  arm: string;
  judge: string;
  caseId: string;
  criterionId: string;
  repeat: number;
  split: string;
}

export interface ResultsFile {
  split: string;
  stoppedAtCap: boolean;
  rows: Row[];
}

/** What's missing from a results file, against the split's criteria. */
export function resultsProblems(
  results: ResultsFile,
  criteria: readonly { caseId: string; criterionId: string }[],
): string[] {
  const problems: string[] = [];
  if (results.split !== "heldout")
    problems.push(`the results are for the ${results.split} split, not heldout`);
  if (results.stoppedAtCap) problems.push("the run stopped at its spend cap");
  if (results.rows.some((r) => r.split !== "heldout"))
    problems.push("rows from outside the held-out split");
  const have = new Set(
    results.rows.map((r) => `${r.arm}|${r.judge}|${r.caseId}|${r.criterionId}|${r.repeat}`),
  );
  for (const arm of ARMS) {
    const repeats = [...new Set(results.rows.filter((r) => r.arm === arm).map((r) => r.repeat))];
    if (repeats.length < 2) {
      problems.push(`arm ${arm} has ${repeats.length} repeat(s): a spread needs 2 or more`);
      continue;
    }
    for (const repeat of repeats) {
      for (const judge of JUDGES[arm]) {
        const missing = criteria.filter(
          (c) => !have.has(`${arm}|${judge}|${c.caseId}|${c.criterionId}|${repeat}`),
        );
        if (missing.length > 0) {
          problems.push(
            `arm ${arm} (${judge}) repeat ${repeat} misses ${missing.length} criteria, e.g. ${missing[0]!.caseId} ${missing[0]!.criterionId}`,
          );
        }
      }
    }
  }
  return problems;
}

/** What the README's results section lacks. */
export function readmeProblems(readme: string): string[] {
  const start = readme.indexOf("## IntentBench");
  if (start < 0) return ["no IntentBench section"];
  const section = readme.slice(start, readme.indexOf("\n## ", start + 1) >>> 0 || undefined);
  const problems: string[] = [];
  for (const arm of ARMS)
    if (!new RegExp(`^\\|\\s*${arm}\\s*\\|`, "m").test(section))
      problems.push(`no table row for arm ${arm}`);
  if (!/small n/i.test(section)) problems.push("no small-n caveat");
  return problems;
}

export const isPng = (bytes: Uint8Array) =>
  bytes.length > 8 &&
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b);
