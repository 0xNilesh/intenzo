// IntentBench's judging results (T6.3): one row per arm, judge, case, criterion and repeat, the
// file T6.4's analysis reads (bench/analysis). Every row names the pack it judged by its sha256 in
// manifest.json, so a result always points at the exact evidence.
import { CriterionId, ReasonCode, VerdictValue } from "@intenzo/core";
import { z } from "zod";

import { CaseKind } from "./case.ts";

export const JudgeName = z.enum(["spark-1.3", "spark-open", "dual"]);
export type JudgeName = z.infer<typeof JudgeName>;

export const ResultRow = z.strictObject({
  arm: z.enum(["A", "B", "C", "D"]),
  /** dual: both judges with §22.3's agreement; else the one model that judged. */
  judge: JudgeName,
  caseId: z.string(),
  criterionId: CriterionId,
  kind: CaseKind,
  split: z.enum(["tuning", "heldout"]),
  /** The ground truth (cases/<id>.json). */
  label: z.enum(["pass", "fail"]),
  repeat: z.number().int().positive(),
  verdict: VerdictValue,
  reason: z.union([ReasonCode, z.literal("unsure")]),
  /** §19 e: whether the second PR take was judged. */
  rerecorded: z.boolean(),
  /** Model calls made for this row (shared calls are counted on the dual row). */
  calls: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
  ms: z.number().nonnegative(),
  /** manifest.json's sha256 of the pack judged. */
  pack: z.string(),
});
export type ResultRow = z.infer<typeof ResultRow>;

export const Results = z.strictObject({
  startedAt: z.iso.datetime(),
  split: z.enum(["tuning", "heldout"]),
  arms: z.array(z.enum(["A", "B", "C", "D"])),
  repeats: z.strictObject({ ABC: z.number().int().positive(), D: z.number().int().positive() }),
  rows: z.array(ResultRow),
  totals: z.strictObject({
    calls: z.number().int().nonnegative(),
    usd: z.number().nonnegative(),
    ms: z.number().nonnegative(),
  }),
  /** True when the --max-usd cap stopped the run early: the rows are what was judged. */
  stoppedAtCap: z.boolean(),
  /** Units judged again later (--redo), whose rows replaced the first ones. */
  rejudged: z
    .array(
      z.strictObject({
        at: z.iso.datetime(),
        why: z.string(),
        units: z.number().int().nonnegative(),
        calls: z.number().int().nonnegative(),
        usd: z.number().nonnegative(),
      }),
    )
    .optional(),
});

/** A unit of judging: one arm's judgement of one criterion in one repeat (all its judges' rows). */
export const unitKey = (r: Pick<ResultRow, "arm" | "caseId" | "criterionId" | "repeat">) =>
  `${r.arm}|${r.caseId}|${r.criterionId}|${r.repeat}`;

/** The units in which any row came out with this reason. */
export function unitsWith(results: Results, reason: ResultRow["reason"]): Set<string> {
  return new Set(results.rows.filter((r) => r.reason === reason).map(unitKey));
}

/** The first results with the redone units' rows replaced, and the redo added to the totals. */
export function mergeRedo(
  first: Results,
  redo: Results,
  units: ReadonlySet<string>,
  why: string,
): Results {
  const kept = first.rows.filter((r) => !units.has(unitKey(r)));
  const fresh = redo.rows.filter((r) => units.has(unitKey(r)));
  const round = (n: number) => Math.round(n * 1e4) / 1e4;
  return Results.parse({
    ...first,
    rows: [...kept, ...fresh],
    totals: {
      calls: first.totals.calls + redo.totals.calls,
      usd: round(first.totals.usd + redo.totals.usd),
      ms: first.totals.ms + redo.totals.ms,
    },
    stoppedAtCap: first.stoppedAtCap || redo.stoppedAtCap,
    rejudged: [
      ...(first.rejudged ?? []),
      {
        at: redo.startedAt,
        why,
        units: units.size,
        calls: redo.totals.calls,
        usd: redo.totals.usd,
      },
    ],
  });
}
export type Results = z.infer<typeof Results>;
