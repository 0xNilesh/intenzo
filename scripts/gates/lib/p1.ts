// The Phase 1 gate's answer key (ROADMAP P1 gate): what each criterion's lane must read on each
// side, as fixtures/ground-truth.json writes it, and the check that scores a recorded lane with it.

import { CriterionId, LaneStatus, type Reading } from "@intenzo/core";
import { z } from "zod";

export const SIDES = ["pr", "base"] as const;
export type Side = (typeof SIDES)[number];

/** A POST reading may start this early, for rounding between clocks (§21.4: they agree < 1 ms). */
export const EARLY_TOLERANCE_MS = 5;

const OffsetMs = z.number().int().nonnegative();

/** One reading the lane must take, or, with several `atMs`, the same reading at each offset. */
export const ExpectedReading = z
  .object({
    label: z.string().min(1),
    phase: z.enum(["pre", "post", "after_reload"]),
    /** POST only: the offsets after Tt at which this holds. */
    atMs: z.array(OffsetMs).min(1).optional(),
    kind: z.enum(["text", "region_diff", "absent"]),
    /** The exact value. */
    value: z.string().optional(),
    /** Lines the value must contain, in any order (region snapshots and diffs). */
    includes: z.array(z.string().min(1)).min(1).optional(),
    /** true: the reading has a bbox; false: it has none. Left out: not checked. */
    bbox: z.boolean().optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if ((r.phase === "post") !== (r.atMs !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["atMs"], message: "POST readings, and only they" });
    }
    if (r.kind === "absent" && (r.value !== undefined || r.includes || r.bbox)) {
      ctx.addIssue({ code: "custom", path: ["kind"], message: "an absent reading has no value" });
    }
    if (r.kind !== "absent" && (r.value === undefined) === (r.includes === undefined)) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "give value or includes" });
    }
  });
export type ExpectedReading = z.infer<typeof ExpectedReading>;

export const SideTruth = z
  .object({ status: LaneStatus, readings: z.array(ExpectedReading).min(1) })
  .strict();
export type SideTruth = z.infer<typeof SideTruth>;

export const GroundTruth = z
  .object({
    $comment: z.array(z.string()),
    /** POST readings after Tt, in order (§21.3). */
    offsetsMs: z.array(OffsetMs).min(1),
    sides: z.object({
      pr: z.object({ branch: z.string(), url: z.url() }).strict(),
      base: z.object({ branch: z.string(), url: z.url() }).strict(),
    }),
    criteria: z.record(
      CriterionId,
      z.object({ note: z.string().optional(), pr: SideTruth, base: SideTruth }).strict(),
    ),
  })
  .strict()
  .superRefine((truth, ctx) => {
    for (const [id, sides] of Object.entries(truth.criteria)) {
      for (const side of SIDES) {
        const seen = new Set<string>();
        sides[side].readings.forEach((r, n) => {
          const path = ["criteria", id, side, "readings", n];
          for (const at of r.atMs ?? []) {
            if (!truth.offsetsMs.includes(at)) {
              ctx.addIssue({ code: "custom", path, message: `+${at} ms isn't in offsetsMs` });
            }
          }
          for (const key of keysOf(r)) {
            if (seen.has(key)) ctx.addIssue({ code: "custom", path, message: `${key} twice` });
            seen.add(key);
          }
        });
      }
    }
  });
export type GroundTruth = z.infer<typeof GroundTruth>;

/** The keys a reading is matched by: "label · pre", "label · post +1000 ms", "label · after_reload". */
const keyOf = (label: string, phase: string, atMs?: number) =>
  atMs === undefined ? `${label} · ${phase}` : `${label} · ${phase} +${atMs} ms`;
const keysOf = (r: ExpectedReading) =>
  r.atMs ? r.atMs.map((at) => keyOf(r.label, r.phase, at)) : [keyOf(r.label, r.phase)];

export interface RecordedLane {
  status: string;
  tTriggerMs: number | null;
  readings: readonly Reading[];
}

const show = (value: string | null) => (value === null ? "null" : JSON.stringify(value));

/**
 * What differs between a recorded lane and its ground truth; empty when they match. A label's nth
 * POST reading is the one taken at offsetsMs[n], and it must be taken inside that offset's window.
 * The lane must have exactly the expected readings: a missing or an extra one is a difference.
 */
export function compareLane(
  truth: SideTruth,
  lane: RecordedLane,
  offsetsMs: readonly number[],
): string[] {
  const problems: string[] = [];
  if (lane.status !== truth.status) {
    problems.push(`status: expected ${truth.status}, got ${lane.status}`);
  }

  const observed = new Map<string, Reading>();
  const postCount = new Map<string, number>();
  for (const r of lane.readings) {
    let key = keyOf(r.label, r.phase);
    if (r.phase === "post") {
      const n = postCount.get(r.label) ?? 0;
      postCount.set(r.label, n + 1);
      const at = offsetsMs[n];
      key = at === undefined ? `${r.label} · post #${n + 1}` : keyOf(r.label, "post", at);
      if (at !== undefined && lane.tTriggerMs !== null) {
        const late = offsetsMs[n + 1];
        const dt = Math.round(r.tMs - lane.tTriggerMs);
        if (dt < at - EARLY_TOLERANCE_MS || (late !== undefined && dt >= late)) {
          problems.push(`${key}: read at Tt+${dt} ms, outside its window`);
        }
      }
    }
    if (observed.has(key)) problems.push(`${key}: read twice`);
    observed.set(key, r);
  }

  const expected = new Set<string>();
  for (const e of truth.readings) {
    for (const key of keysOf(e)) {
      expected.add(key);
      const r = observed.get(key);
      if (!r) {
        problems.push(`${key}: missing`);
        continue;
      }
      if (r.kind !== e.kind) {
        problems.push(`${key}: expected kind ${e.kind}, got ${r.kind} ${show(r.value)}`);
        continue;
      }
      if (e.value !== undefined && r.value !== e.value) {
        problems.push(`${key}: expected ${show(e.value)}, got ${show(r.value)}`);
      }
      const lines = (r.value ?? "").split("\n");
      for (const line of e.includes ?? []) {
        if (!lines.includes(line)) problems.push(`${key}: no line ${show(line)}`);
      }
      if (e.bbox !== undefined && (r.bbox !== null) !== e.bbox) {
        const got = r.bbox ? `[${r.bbox.join(", ")}]` : "none";
        problems.push(`${key}: expected ${e.bbox ? "a bbox" : "no bbox"}, got ${got}`);
      }
    }
  }
  for (const [key, r] of observed) {
    if (!expected.has(key)) problems.push(`${key}: unexpected reading ${show(r.value)}`);
  }
  return problems;
}
