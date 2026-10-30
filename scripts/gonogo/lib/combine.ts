import type { Criterion, JudgeOutput, Reading, VerdictValue } from "./schema.ts";

// ARCHITECTURE §22.3, as the go/no-go applies it to one recording (no §19e re-record). T4.5 builds
// the production version in core/judge.

/** The §7 reason codes this rule can produce, plus `primary_pass` for the R13 what-if. */
export type Reason =
  | "agreed"
  | "judges_disagree"
  | "wrong_target"
  | "contradicts_readings"
  | "infra_error"
  | "primary_pass";

/** One judge's verdict after the §22.3 per-judge checks; `reason` says why it became inconclusive. */
export interface Checked {
  verdict: VerdictValue;
  reason: Reason | null;
}

export interface Combined {
  verdict: VerdictValue;
  reason: Reason;
}

/**
 * Whole numeric tokens as cents: currency, signs and thousands separators are dropped, and a digit
 * run inside a word ("SAVE10", "3s") isn't a number.
 */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/(?<![\w.])\d[\d,]*(?:\.\d+)?(?!\w)/g)].map((m) =>
    Math.round(Number(m[0].replace(/,/g, "")) * 100),
  );
}

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[−–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .toLowerCase();
}

/** The forms of one reading line a citation may equal: the line, without its diff marker, and
 * the text of an ARIA line (`alert: text` or `alert "name"`). */
function lineForms(line: string): string[] {
  const unmarked = line.replace(/^[+-] /, "");
  const named = [...unmarked.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  const text = /^[\w-]+(?: "[^"]*")?: (.*)$/.exec(unmarked)?.[1];
  return [line, unmarked, ...named, ...(text === undefined ? [] : [text])].map(normalize);
}

/**
 * §22.3 valueMatches, on tokens rather than substrings. If the cited value has numbers, each must
 * equal a whole numeric token of a cited reading (5.00 ≠ 45.00). Otherwise the normalized value
 * must equal a whole line of a cited reading, or the text of a region_diff line. Empty → no match.
 */
export function valueMatches(citedValue: string | null, cited: readonly Reading[]): boolean {
  if (citedValue === null || citedValue.trim() === "") return false;
  const lines = cited.flatMap((r) => (r.value === null ? [] : r.value.split("\n")));
  const wanted = numbersIn(citedValue);
  if (wanted.length > 0) {
    const have = new Set(lines.flatMap(numbersIn));
    return wanted.every((n) => have.has(n));
  }
  const value = normalize(citedValue);
  return lines.some((line) => lineForms(line).includes(value));
}

/** §22.3 per judge: a wrong target is inconclusive; a pass or fail must cite matching readings. */
export function checkJudge(
  output: JudgeOutput | null,
  criterion: Criterion,
  readings: readonly Reading[],
): Checked {
  if (output === null) return { verdict: "inconclusive", reason: "infra_error" };
  if (!output.targetCorrect) return { verdict: "inconclusive", reason: "wrong_target" };
  const needsCitation =
    output.verdict !== "inconclusive" &&
    criterion.watch.length > 0 &&
    criterion.kind !== "ui_visual";
  if (needsCitation) {
    const cited = output.citedReadings.map((i) => readings.find((r) => r.i === i));
    const known = cited.filter((r): r is Reading => r !== undefined);
    if (
      known.length === 0 ||
      known.length < cited.length ||
      !valueMatches(output.citedValue, known)
    )
      return { verdict: "inconclusive", reason: "contradicts_readings" };
  }
  return { verdict: output.verdict, reason: null };
}

const PRECEDENCE: Reason[] = ["infra_error", "wrong_target", "contradicts_readings"];

/** §22.3: the final verdict is pass or fail only when both checked judges say it. */
export function combine(a: Checked, b: Checked): Combined {
  if (a.verdict === b.verdict && a.verdict !== "inconclusive") {
    return { verdict: a.verdict, reason: "agreed" };
  }
  const reason = PRECEDENCE.find((r) => a.reason === r || b.reason === r) ?? "judges_disagree";
  return { verdict: "inconclusive", reason };
}

/**
 * §34 R13, the fallback if the strict rule is inconclusive too often: fail still needs both judges,
 * pass needs only the primary judge (A, Spark Open) with clean citations.
 */
export function combineR13(primary: Checked, other: Checked): Combined {
  if (primary.verdict === "pass") return { verdict: "pass", reason: "primary_pass" };
  return combine(primary, other);
}
