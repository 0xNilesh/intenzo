import type { Label } from "../clips.ts";
import type { Checked, Combined } from "./combine.ts";
import type { JudgeKey, Usage } from "./judge.ts";
import { decide, score, seconds, type Metrics } from "./score.ts";
import type { JudgeOutput } from "./schema.ts";

export interface JudgeResult {
  key: JudgeKey;
  name: string;
  output: JudgeOutput | null;
  checked: Checked;
  error?: string;
  ms: number;
  requests: number;
  usage: Usage;
  costUsd: number;
  /** True when the answer came from probes/gonogo/judgements/ instead of a new call. */
  cached: boolean;
}

export interface ClipResult {
  id: string;
  label: Label;
  truth: string;
  /** Judge A (primary, Spark Open) then judge B (Spark 1.3). */
  judges: [JudgeResult, JudgeResult];
  final: Combined;
  r13: Combined;
  /** Both judges run in parallel, so the clip waits for the slower one. */
  verdictMs: number;
}

/** A judge's answer, and what the §22.3 per-judge checks made of it. */
export function judgeCell(j: JudgeResult): string {
  if (j.output === null) return "error";
  if (j.checked.reason === "wrong_target") return `${j.output.verdict}→✗target`;
  if (j.checked.reason === "contradicts_readings") return `${j.output.verdict}→✗cite`;
  return j.output.verdict;
}

const pad = (text: string, width: number): string => text.padEnd(width);

export function formatTable(results: readonly ClipResult[]): string[] {
  const [a, b] = results[0]?.judges ?? [{ name: "A" }, { name: "B" }];
  const head = [
    pad("clip", 24),
    pad("truth", 10),
    pad(a.name, 18),
    pad(b.name, 18),
    pad("final", 38),
    "time",
  ];
  const rows = results.map((r) =>
    [
      pad(r.id, 24),
      pad(r.label, 10),
      pad(judgeCell(r.judges[0]), 18),
      pad(judgeCell(r.judges[1]), 18),
      pad(`${r.final.verdict} (${r.final.reason})${mark(r)}`, 38),
      seconds(r.verdictMs),
    ].join(""),
  );
  return [head.join(""), ...rows];
}

/** ✓ right, ✗ wrong (a false fail or false pass), blank for inconclusive or ambiguous. */
function mark(r: ClipResult): string {
  if (r.label === "ambiguous" || r.final.verdict === "inconclusive") return "";
  return r.final.verdict === r.label ? " ✓" : " ✗";
}

/** Scores verdicts produced by one rule (strict, R13, or a single judge). */
export function scoreBy(
  results: readonly ClipResult[],
  verdictOf: (r: ClipResult) => Combined | Checked,
  msOf: (r: ClipResult) => number = (r) => r.verdictMs,
): Metrics {
  return score(
    results.map((r) => ({ label: r.label, verdict: verdictOf(r).verdict, verdictMs: msOf(r) })),
  );
}

export function oneLine(m: Metrics): string {
  const acc = m.accuracy === null ? "n/a" : `${Math.round(m.accuracy * 100)}%`;
  const inc = m.inconclusiveRate === null ? "n/a" : `${Math.round(m.inconclusiveRate * 100)}%`;
  const time = m.verdictMs
    ? `, p50 ${seconds(m.verdictMs.p50)}, max ${seconds(m.verdictMs.max)}`
    : "";
  return `accuracy ${m.correct}/${m.decided} = ${acc}, false fails ${m.falseFails}, false passes ${m.falsePasses}, inconclusive ${m.inconclusive}/${m.clear} = ${inc}${time}`;
}

export interface Summary {
  lines: string[];
  go: boolean;
  strict: Metrics;
  r13: Metrics;
  judges: Record<string, Metrics>;
}

export function summarize(results: readonly ClipResult[]): Summary {
  const strict = scoreBy(results, (r) => r.final);
  const r13 = scoreBy(results, (r) => r.r13);
  const { go, checks } = decide(strict);
  const judges: Record<string, Metrics> = {};
  const lines = [
    "Strict §22.3 rule (both judges must agree):",
    ...checks.map((c) => `  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`),
    `    false passes on almost-right clips: ${strict.falsePasses}`,
    `    ambiguous clips: ${
      results
        .filter((r) => r.label === "ambiguous")
        .map((r) => `${r.id} → ${r.final.verdict}`)
        .join(", ") || "none"
    }`,
    "Each judge alone (its own §22.3 checks, no agreement needed):",
  ];
  for (const n of [0, 1] as const) {
    const name = results[0]?.judges[n].name ?? `judge ${n}`;
    judges[name] = scoreBy(
      results,
      (r) => r.judges[n].checked,
      (r) => r.judges[n].ms,
    );
    lines.push(`  ${name}: ${oneLine(judges[name])}`);
  }
  lines.push(`R13 what-if (pass on judge A alone, fail still needs both): ${oneLine(r13)}`);
  return { lines, go, strict, r13, judges };
}
