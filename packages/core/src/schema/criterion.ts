import { z } from "zod";

export const CriterionId = z
  .string()
  .regex(/^C\d+$/, { message: "criterion ids look like C1, C2, …" });

/** One acceptance criterion extracted from the ticket (ARCHITECTURE §7, §18). */
export const Criterion = z.object({
  id: CriterionId,
  text: z.string().min(1),
  /** What to DO to exercise it. */
  trigger: z.string(),
  /** Preconditions, e.g. "logged in", "cart has an item worth ≥ $50". */
  setup: z.array(z.string()),
  /** What must be TRUE afterwards. Judges only: the navigator never sees it (§20.6). */
  expected: z.string(),
  /** Things to observe, e.g. "order total". */
  watch: z.array(z.string()).max(3),
  kind: z.enum(["ui_behavior", "ui_visual", "copy", "not_verifiable_in_ui"]),
  /** Should the result survive a reload? Turns on the reload probe (§21.3). */
  persistence: z.boolean(),
  /** An explicit timing claim in ms ("within 500 ms"; "instantly" → 1000). */
  timingMs: z.number().int().positive().optional(),
  /** True when the ticket didn't state it explicitly. */
  inferred: z.boolean(),
  /** The exact ticket text or transcript span it came from. */
  sourceQuote: z.string().optional(),
  /** Ms into the PM video where it's shown. Comes from Spark watching the video: transcripts have no timings. */
  sourceMediaAt: z.number().nonnegative().optional(),
});
export type Criterion = z.infer<typeof Criterion>;

/** Hints from the PM video ticket that seed the navigator. */
export const ReproHints = z.object({
  startPath: z.string().startsWith("/").optional(),
  steps: z.array(z.string()),
});
export type ReproHints = z.infer<typeof ReproHints>;

export const CriterionSet = z
  .object({
    criteria: z.array(Criterion).max(6),
    repro: ReproHints.optional(),
    intentSource: z.enum(["linked_issue", "linked_issue_video", "pr_body", "inferred"]),
    /** sha256 of the normalized ticket text and media hashes. Never the diff (§18). */
    ticketHash: z.string().regex(/^[0-9a-f]{64}$/, { message: "must be a sha256 hex digest" }),
  })
  .superRefine((set, ctx) => {
    const seen = new Set<string>();
    set.criteria.forEach((c, i) => {
      if (seen.has(c.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["criteria", i, "id"],
          message: `duplicate criterion id ${c.id}`,
        });
      }
      seen.add(c.id);
    });
  });
export type CriterionSet = z.infer<typeof CriterionSet>;

/** Which diff files could implement each criterion, and candidate start routes (§18). */
export const CoverageMap = z.object({
  items: z.array(
    z.object({
      criterionId: CriterionId,
      files: z.array(z.string()),
      status: z.enum(["covered", "uncovered", "unclear"]),
    }),
  ),
  routes: z.array(z.string()),
});
export type CoverageMap = z.infer<typeof CoverageMap>;
