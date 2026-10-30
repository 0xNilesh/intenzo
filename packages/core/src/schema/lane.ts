import { z } from "zod";

import { ArtifactRef } from "./artifact.ts";
import { CriterionId } from "./criterion.ts";
import { LoggedStep } from "./navigation.ts";

/**
 * One observation of a watch target (§21.3). Times are the canonical clock: epoch ms, the same in
 * Node and the page (§21.4).
 */
export const Reading = z
  .object({
    /** Index cited by the judges. Unique within a lane. */
    i: z.number().int().nonnegative(),
    label: z.string(),
    /** text = innerText; region_diff = line diff of a region's aria snapshot vs PRE ("no change"
     *  when nothing changed); absent = the target didn't resolve. */
    kind: z.enum(["text", "region_diff", "absent"]),
    phase: z.enum(["pre", "post", "after_reload"]),
    tMs: z.number(),
    value: z.string().nullable(),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  })
  .superRefine((r, ctx) => {
    if ((r.kind === "absent") !== (r.value === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "absent readings have no value, and only absent ones",
      });
    }
  });
export type Reading = z.infer<typeof Reading>;

export const StepLogEntry = z.object({
  tMs: z.number(),
  step: LoggedStep,
  ok: z.boolean(),
  /** True for the steps that exercise the criterion; the last one's time is Tt. */
  trigger: z.boolean().default(false),
  error: z.string().optional(),
});
export type StepLogEntry = z.infer<typeof StepLogEntry>;

export const LaneStatus = z.enum([
  /** The trigger ran; readings may still be absent. */
  "completed",
  /** Couldn't reach the preconditions → inconclusive. */
  "setup_failed",
  /** Setup reached, trigger control not found → judged, but can't pass (§22.1). */
  "trigger_absent",
  /** e.g. test data missing. */
  "precondition_unmet",
  "timeout",
  "error",
]);

/** One recording of one criterion on one side (§7, §21). */
export const LaneResult = z
  .object({
    criterionId: CriterionId,
    side: z.enum(["pr", "base"]),
    status: LaneStatus,
    failedStepIndex: z.number().int().nonnegative().optional(),
    /** Epoch ms when the lane's page, and so its video, started. */
    laneStartMs: z.number(),
    /** Tt on the canonical clock; null when the trigger never ran. */
    tTriggerMs: z.number().nullable(),
    humanVideo: ArtifactRef.optional(),
    judgeVideo: ArtifactRef.optional(),
    trace: ArtifactRef.optional(),
    /** The Tt+1000 screenshot with labelled watch boxes, drawn offline (§21.3). */
    annotatedShot: ArtifactRef.optional(),
    /** rAF-sampled bbox per watch element (JSON). */
    boxTrack: ArtifactRef.optional(),
    stepLog: z.array(StepLogEntry),
    readings: z.array(Reading),
    consoleErrorCount: z.number().int().nonnegative(),
    failedRequestCount: z.number().int().nonnegative(),
    isolation: z.enum(["ephemeral_user", "reset_hook", "none"]),
    /** Canonical ms → each video's ms. Required whenever there's a video (§21.4). */
    videoOffsets: z.object({ human: z.number(), judge: z.number() }).optional(),
  })
  .superRefine((lane, ctx) => {
    if (lane.status === "completed" && lane.tTriggerMs === null) {
      ctx.addIssue({
        code: "custom",
        path: ["tTriggerMs"],
        message: "a completed lane has a trigger time",
      });
    }
    if (lane.tTriggerMs !== null && !lane.stepLog.some((s) => s.trigger)) {
      ctx.addIssue({
        code: "custom",
        path: ["stepLog"],
        message: "a trigger time needs a trigger step",
      });
    }
    if (lane.failedStepIndex !== undefined && lane.failedStepIndex >= lane.stepLog.length) {
      ctx.addIssue({
        code: "custom",
        path: ["failedStepIndex"],
        message: "points past the step log",
      });
    }
    if ((lane.humanVideo || lane.judgeVideo) && !lane.videoOffsets) {
      ctx.addIssue({
        code: "custom",
        path: ["videoOffsets"],
        message: "required when the lane has a video",
      });
    }
    const seen = new Set<number>();
    lane.readings.forEach((r, n) => {
      if (seen.has(r.i)) {
        ctx.addIssue({
          code: "custom",
          path: ["readings", n, "i"],
          message: `duplicate reading index ${r.i}`,
        });
      }
      seen.add(r.i);
    });
  });
export type LaneResult = z.infer<typeof LaneResult>;
