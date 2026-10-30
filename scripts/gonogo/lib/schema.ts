import { z } from "zod";

// Drafts of the ARCHITECTURE §7 schemas, cut down to what the go/no-go needs. T1.1 builds the real
// ones in core/schema; nothing outside scripts/gonogo should import these.

export const Criterion = z.object({
  id: z.string().regex(/^C\d+$/),
  text: z.string(),
  trigger: z.string(),
  setup: z.array(z.string()),
  expected: z.string(),
  watch: z.array(z.string()).max(3),
  kind: z.enum(["ui_behavior", "ui_visual", "copy", "not_verifiable_in_ui"]),
  persistence: z.boolean(),
  timingMs: z.number().int().optional(),
  inferred: z.boolean(),
  sourceQuote: z.string().optional(),
});
export type Criterion = z.infer<typeof Criterion>;

// §7 Target, limited to the two kinds the fixture shop needs.
export const Target = z.discriminatedUnion("by", [
  z.object({ by: z.literal("testId"), id: z.string() }),
  z.object({ by: z.literal("role"), role: z.string(), name: z.string().optional() }),
]);
export type Target = z.infer<typeof Target>;

export const WatchTarget = z.object({
  label: z.string(),
  scope: z.literal("element"),
  target: Target,
});
export type WatchTarget = z.infer<typeof WatchTarget>;

export const Step = z.discriminatedUnion("op", [
  z.object({ op: z.literal("goto"), path: z.string() }),
  z.object({ op: z.literal("click"), target: Target }),
  z.object({ op: z.literal("fill"), target: Target, value: z.string() }),
  // Not a §7 Step: the recorder's persistence probe (§21.3 step 10), logged like one.
  z.object({ op: z.literal("reload") }),
]);
export type Step = z.infer<typeof Step>;

export const StepLogEntry = z.object({
  tMs: z.number(),
  step: Step,
  ok: z.boolean(),
  trigger: z.boolean(),
  error: z.string().optional(),
});
export type StepLogEntry = z.infer<typeof StepLogEntry>;

export const Reading = z.object({
  i: z.number().int(),
  label: z.string(),
  kind: z.enum(["text", "region_diff", "absent"]),
  phase: z.enum(["pre", "post", "after_reload"]),
  tMs: z.number(),
  value: z.string().nullable(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
});
export type Reading = z.infer<typeof Reading>;

export const VerdictValue = z.enum(["pass", "fail", "inconclusive"]);
export type VerdictValue = z.infer<typeof VerdictValue>;

/** What each judge must answer (§7). Times are lane ms, read off the clip's burned-in clock. */
export const JudgeOutput = z.object({
  verdict: VerdictValue,
  targetCorrect: z.boolean(),
  citedReadings: z.array(z.number().int()),
  citedValue: z.string().nullable(),
  atMs: z.number().nullable(),
  observed: z.string(),
});
export type JudgeOutput = z.infer<typeof JudgeOutput>;

/** A recorded lane: the parts of §7 LaneResult the judge bundle needs. All times are epoch ms. */
export const Lane = z.object({
  clipId: z.string(),
  /** When the page, and so its video, started: video time ≈ canonical time − laneStartMs. */
  laneStartMs: z.number(),
  tTriggerMs: z.number(),
  stepLog: z.array(StepLogEntry),
  readings: z.array(Reading),
  consoleErrorCount: z.number().int(),
  failedRequestCount: z.number().int(),
});
export type Lane = z.infer<typeof Lane>;
