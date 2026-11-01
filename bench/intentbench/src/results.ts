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
});
export type Results = z.infer<typeof Results>;
