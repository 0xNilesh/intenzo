import { z } from "zod";

import { CriterionId } from "./criterion.ts";

export const VerdictValue = z.enum(["pass", "fail", "inconclusive"]);
export type VerdictValue = z.infer<typeof VerdictValue>;

/** What each judge answers (§7, §22.2). */
export const JudgeOutput = z.object({
  verdict: VerdictValue,
  /** Are the labelled watch boxes / readings about the thing the criterion describes? */
  targetCorrect: z.boolean(),
  /** Indices into the lane's readings. */
  citedReadings: z.array(z.number().int().nonnegative()),
  /** The decisive value, verbatim from a cited reading (checked by valueMatches, §22.3). */
  citedValue: z.string().nullable(),
  /** Canonical ms, read off the clip's burned-in clock. A chapter hint only. */
  atMs: z.number().nullable(),
  observed: z.string(),
});
export type JudgeOutput = z.infer<typeof JudgeOutput>;

export const ReasonCode = z.enum([
  "agreed",
  "judges_disagree",
  "wrong_target",
  "contradicts_readings",
  "setup_failed",
  "precondition_unmet",
  "no_isolation",
  "flaky",
  "not_verifiable_in_ui",
  "infra_error",
]);
export type ReasonCode = z.infer<typeof ReasonCode>;

/** The final per-criterion result (§7, §22.3–§22.4). */
export const Verdict = z
  .object({
    criterionId: CriterionId,
    verdict: VerdictValue,
    reasonCode: ReasonCode,
    /** From the step log ([Tt − 1000, Tt + 3000]), never from a judge's atMs. */
    evidenceWindow: z
      .object({ startMs: z.number(), endMs: z.number() })
      .refine((w) => w.endMs >= w.startMs, { message: "ends before it starts", path: ["endMs"] })
      .nullable(),
    observed: z.string(),
    judges: z.array(JudgeOutput.extend({ model: z.string().min(1) })),
  })
  .superRefine((v, ctx) => {
    // §22.3: pass and fail only come from two agreeing judges; everything else is inconclusive.
    if (v.verdict !== "inconclusive" && v.reasonCode !== "agreed") {
      ctx.addIssue({
        code: "custom",
        path: ["reasonCode"],
        message: "pass and fail need two agreeing judges",
      });
    }
    if (v.verdict === "inconclusive" && v.reasonCode === "agreed") {
      ctx.addIssue({
        code: "custom",
        path: ["reasonCode"],
        message: "an inconclusive verdict needs its reason",
      });
    }
  });
export type Verdict = z.infer<typeof Verdict>;

export const RunOutcome = z.enum([
  "pass",
  "fail",
  "inconclusive",
  "error",
  "cancelled",
  "superseded",
]);
export type RunOutcome = z.infer<typeof RunOutcome>;
