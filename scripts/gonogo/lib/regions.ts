/** Written into a region_diff reading when nothing appeared or disappeared, so it can be cited. */
export const NO_CHANGE = "no change";

/** Lines of a Playwright ARIA snapshot without the YAML list markers or indentation. */
export function snapshotLines(snapshot: string): string[] {
  return snapshot
    .split("\n")
    .map((line) => line.trim().replace(/^- /, ""))
    .filter((line) => line !== "");
}

/**
 * The §21.3 region diff: lines that appeared after the trigger ("+ alert: This code has expired")
 * or disappeared ("- …"), compared as multisets so a repeated line counts each time.
 */
export function diffLines(before: readonly string[], after: readonly string[]): string {
  const remaining = new Map<string, number>();
  for (const line of before) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of after) {
    const left = remaining.get(line) ?? 0;
    if (left > 0) remaining.set(line, left - 1);
    else added.push(`+ ${line}`);
  }
  const removed = [...remaining].flatMap(([line, n]) => Array<string>(n).fill(`- ${line}`));
  const lines = [...added, ...removed];
  return lines.length > 0 ? lines.join("\n") : NO_CHANGE;
}
