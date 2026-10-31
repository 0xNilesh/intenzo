import type {
  Criterion,
  JudgeOutput,
  LaneResult,
  ReasonCode,
  Reading,
  VerdictValue,
} from "../schema/index.ts";

// The deterministic rules around the two judges (ARCHITECTURE §22.1, §22.3, §19 e): what's
// decided before any judge looks, how each judge's answer is checked against the readings, how the
// two combine, what a re-record may change, and the caps no judge can talk past. Moved from the
// go/no-go (scripts/gonogo/lib/combine.ts), which applied §22.3 to single recordings.

/** One judge's verdict after the §22.3 checks; `reason` says why it became inconclusive. */
export interface Checked {
  verdict: VerdictValue;
  reason: ReasonCode | null;
}

/** A criterion's verdict and its reason code (§7). */
export interface Combined {
  verdict: VerdictValue;
  reason: ReasonCode;
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
  criterion: Pick<Criterion, "watch" | "kind">,
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
    ) {
      return { verdict: "inconclusive", reason: "contradicts_readings" };
    }
  }
  return { verdict: output.verdict, reason: null };
}

const PRECEDENCE: ReasonCode[] = ["infra_error", "wrong_target", "contradicts_readings"];

/** §22.3: the final verdict is pass or fail only when both checked judges say it. */
export function combine(a: Checked, b: Checked): Combined {
  if (a.verdict === b.verdict && a.verdict !== "inconclusive") {
    return { verdict: a.verdict, reason: "agreed" };
  }
  const reason = PRECEDENCE.find((r) => a.reason === r || b.reason === r) ?? "judges_disagree";
  return { verdict: "inconclusive", reason };
}

/** §19 e: why the PR side is recorded once more, or null when the first result stands. */
export function rerecordFor(first: Combined): "confirm_fail" | "break_tie" | null {
  if (first.verdict === "fail") return "confirm_fail";
  if (first.reason === "judges_disagree") return "break_tie";
  return null;
}

/**
 * §19 e, after the one re-record. A fail stands only if the new take fails again (else `flaky`).
 * A tie is settled only by an agreed verdict that one of the first two judges had already given:
 * re-recording until the judges happen to agree on something new is judge-shopping.
 */
export function afterRerecord(
  first: Combined,
  firstJudges: readonly [Checked, Checked],
  second: Combined,
): Combined {
  if (first.verdict === "fail") {
    return second.verdict === "fail" ? second : { verdict: "inconclusive", reason: "flaky" };
  }
  if (first.reason === "judges_disagree") {
    const earlier = new Set(firstJudges.map((j) => j.verdict));
    return second.reason === "agreed" && earlier.has(second.verdict)
      ? second
      : { verdict: "inconclusive", reason: "judges_disagree" };
  }
  return first;
}

/** §22.1: a verdict decided before any judge looks, or null when the judges must look. */
export function preJudge(
  criterion: Pick<Criterion, "kind">,
  pr: Pick<LaneResult, "status"> | null,
): Combined | null {
  if (criterion.kind === "not_verifiable_in_ui") {
    return { verdict: "inconclusive", reason: "not_verifiable_in_ui" };
  }
  switch (pr?.status) {
    case undefined:
      return { verdict: "inconclusive", reason: "infra_error" };
    case "setup_failed":
      return { verdict: "inconclusive", reason: "setup_failed" };
    case "precondition_unmet":
      return { verdict: "inconclusive", reason: "precondition_unmet" };
    case "timeout":
    case "error":
      return { verdict: "inconclusive", reason: "infra_error" };
    default:
      return null; // completed, or trigger_absent: judged (§22.1)
  }
}

/**
 * §22.1's caps on the judges' verdict. A lane whose trigger control was missing can't pass, and
 * fails only when the PR touches the criterion (coverage isn't `uncovered`: the criterion may be
 * for another PR). A lane without isolation is capped at inconclusive.
 */
export function capVerdict(
  combined: Combined,
  pr: Pick<LaneResult, "status" | "isolation">,
  coverage?: "covered" | "uncovered" | "unclear",
): Combined {
  if (combined.verdict === "inconclusive") return combined;
  if (pr.status === "trigger_absent") {
    if (combined.verdict === "pass" || coverage === "uncovered") {
      return { verdict: "inconclusive", reason: "precondition_unmet" };
    }
  }
  if (pr.isolation === "none") return { verdict: "inconclusive", reason: "no_isolation" };
  return combined;
}
