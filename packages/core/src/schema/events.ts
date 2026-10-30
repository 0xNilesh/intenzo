import { z } from "zod";

import { ArtifactRef } from "./artifact.ts";
import { CoverageMap, CriterionId, CriterionSet } from "./criterion.ts";
import { LaneResult } from "./lane.ts";
import { SavedPath } from "./navigation.ts";
import { RunOutcome, Verdict } from "./verdict.ts";

/** A visible change on a touched route that no criterion explains (§24). */
export const UnrequestedChange = z.object({
  route: z.string().startsWith("/"),
  description: z.string().min(1),
  confidence: z.number().min(0).max(1),
  before: ArtifactRef.optional(),
  after: ArtifactRef.optional(),
});
export type UnrequestedChange = z.infer<typeof UnrequestedChange>;

/** A Playwright spec generated from a passing criterion's saved path (§25). */
export const GeneratedTest = z.object({
  criterionId: CriterionId,
  path: z.string().min(1),
  source: z.string().min(1),
  /** Passed its validation run against the PR preview. */
  validated: z.boolean(),
});
export type GeneratedTest = z.infer<typeof GeneratedTest>;

// Every event carries its job and a per-job sequence number: (jobId, seq) is unique, so a retried
// POST is ignored, and Cloud answers 410 to a job that isn't current (§9).
const base = { jobId: z.uuid(), seq: z.number().int().nonnegative() };

/** Worker → Cloud events (§9). Media travel as ArtifactRefs, so bodies stay small. */
export const WorkerEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("started"), ...base }),
  z.object({
    kind: z.literal("intent_ready"),
    ...base,
    intent: CriterionSet,
    coverage: CoverageMap,
  }),
  z.object({
    kind: z.literal("criterion_verdict"),
    ...base,
    verdict: Verdict,
    lanes: z.array(LaneResult),
  }),
  z.object({
    kind: z.literal("criterion_evidence"),
    ...base,
    criterionId: CriterionId,
    gif: ArtifactRef,
    still: ArtifactRef,
  }),
  z.object({ kind: z.literal("path_saved"), ...base, path: SavedPath }),
  z.object({ kind: z.literal("changes_done"), ...base, changes: z.array(UnrequestedChange) }),
  z.object({ kind: z.literal("tests_ready"), ...base, tests: z.array(GeneratedTest) }),
  z.object({
    kind: z.literal("finished"),
    ...base,
    outcome: RunOutcome,
    costUsd: z.number().nonnegative(),
    timings: z.record(z.string(), z.number().nonnegative()),
  }),
  z.object({
    kind: z.literal("failed"),
    ...base,
    error: z.object({ code: z.string().min(1), message: z.string() }),
  }),
]);
export type WorkerEvent = z.infer<typeof WorkerEvent>;
