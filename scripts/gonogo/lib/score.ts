import { median } from "../../probe/lib/stats.ts";
import type { Label } from "../clips.ts";
import type { VerdictValue } from "./schema.ts";

/** The ROADMAP T0.3 GO thresholds. */
export const GO = {
  minAccuracy: 0.8,
  maxFalseFails: 0,
  maxInconclusiveRate: 0.3,
  /** Verdicts must come in under this, so the slowest clip must too. */
  verdictUnderMs: 60_000,
} as const;

export interface ScoredClip {
  label: Label;
  verdict: VerdictValue;
  /** Time to the verdict. Both judges run in parallel, so this is the slower of the two. */
  verdictMs: number;
}

export type Confusion = Record<Label, Record<VerdictValue, number>>;

export interface Latency {
  p50: number;
  max: number;
}

export interface Metrics {
  confusion: Confusion;
  /** Clips with a right answer: label pass or fail (ambiguous clips are reported, not scored). */
  clear: number;
  /** Clear clips that got pass or fail. */
  decided: number;
  /** Decided clear clips whose verdict is their label. */
  correct: number;
  /** correct / decided, or null when nothing was decided. */
  accuracy: number | null;
  /** Correct clips (label pass) judged fail. */
  falseFails: number;
  /** Almost-right clips (label fail) judged pass. */
  falsePasses: number;
  /** Clear clips judged inconclusive. */
  inconclusive: number;
  inconclusiveRate: number | null;
  verdictMs: Latency | null;
}

export function latencyOf(ms: readonly number[]): Latency | null {
  return ms.length === 0 ? null : { p50: Math.round(median(ms)), max: Math.round(Math.max(...ms)) };
}

export function score(clips: readonly ScoredClip[]): Metrics {
  const confusion: Confusion = {
    pass: { pass: 0, fail: 0, inconclusive: 0 },
    fail: { pass: 0, fail: 0, inconclusive: 0 },
    ambiguous: { pass: 0, fail: 0, inconclusive: 0 },
  };
  for (const c of clips) confusion[c.label][c.verdict]++;
  const { pass, fail } = confusion;
  const clear = clips.filter((c) => c.label !== "ambiguous").length;
  const correct = pass.pass + fail.fail;
  const decided = correct + pass.fail + fail.pass;
  const inconclusive = pass.inconclusive + fail.inconclusive;
  return {
    confusion,
    clear,
    decided,
    correct,
    accuracy: decided === 0 ? null : correct / decided,
    falseFails: pass.fail,
    falsePasses: fail.pass,
    inconclusive,
    inconclusiveRate: clear === 0 ? null : inconclusive / clear,
    verdictMs: latencyOf(clips.map((c) => c.verdictMs)),
  };
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const pct = (x: number | null): string => (x === null ? "n/a" : `${Math.round(x * 1000) / 10}%`);

/** The T0.3 go/no-go: GO only when every threshold holds. */
export function decide(m: Metrics): { go: boolean; checks: Check[] } {
  const checks: Check[] = [
    {
      name: "accuracy on decided clips",
      ok: m.accuracy !== null && m.accuracy >= GO.minAccuracy,
      detail: `${m.correct}/${m.decided} = ${pct(m.accuracy)} (need ≥ ${pct(GO.minAccuracy)})`,
    },
    {
      name: "false fails on correct clips",
      ok: m.falseFails <= GO.maxFalseFails,
      detail: `${m.falseFails} (need ${GO.maxFalseFails})`,
    },
    {
      name: "inconclusive on clear clips",
      ok: m.inconclusiveRate !== null && m.inconclusiveRate <= GO.maxInconclusiveRate,
      detail: `${m.inconclusive}/${m.clear} = ${pct(m.inconclusiveRate)} (need ≤ ${pct(GO.maxInconclusiveRate)})`,
    },
    {
      name: "time to verdict",
      ok: m.verdictMs !== null && m.verdictMs.max < GO.verdictUnderMs,
      detail:
        m.verdictMs === null
          ? "no verdicts"
          : `p50 ${seconds(m.verdictMs.p50)}, slowest ${seconds(m.verdictMs.max)} (need < ${seconds(GO.verdictUnderMs)})`,
    },
  ];
  return { go: checks.every((c) => c.ok), checks };
}

export const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
