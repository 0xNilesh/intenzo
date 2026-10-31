import type { LaneResult, SavedPath } from "../schema/index.ts";
import type { ExploreResult } from "./explore.ts";

// Replay and the path cache (ARCHITECTURE §19 step 3a–b, §20.6). A criterion's PR side replays
// its cached path when the run group has one for the current intent; otherwise the navigator
// explores once and the path it saves is recorded. A cached path that breaks on one of its steps
// (the app changed: a renamed button) is discarded, explored once more, and recorded as a new
// take. Exploration is never the evidence: every verdict comes from a clean recorded replay.

/** A cached path is stale when its replay broke on one of its own steps. */
export function replayBroke(lane: Pick<LaneResult, "status" | "failedStepIndex">): boolean {
  return (
    lane.failedStepIndex !== undefined &&
    (lane.status === "setup_failed" || lane.status === "trigger_absent")
  );
}

export interface ReplayDeps<R> {
  /** The run group's saved path for this criterion and intent version, if any. */
  cached: SavedPath | null;
  /** Explores the PR app once (unrecorded, with its own fresh identity). */
  explore: () => Promise<ExploreResult>;
  /** Records a path as the given take. */
  record: (path: SavedPath, take: number) => Promise<R>;
  /** The recorded lane, to tell whether a replay broke. */
  laneOf: (recording: R) => Pick<LaneResult, "status" | "failedStepIndex">;
}

export type ReplayOutcome<R> =
  | {
      kind: "recorded";
      recording: R;
      path: SavedPath;
      /** cache: the cached path replayed; explored: no path was cached; re_explored: the cached one broke. */
      source: "cache" | "explored" | "re_explored";
      take: number;
      /** Set when the navigator ran: it found `path`, which the run group should now save. */
      explored?: ExploreResult;
    }
  | {
      kind: "not_found";
      /** Why the navigator couldn't reach the trigger. */
      explored: Exclude<ExploreResult, { status: "found" }>;
      /** The broken take of the cached path, when there was one. */
      recording?: R;
    };

/** The PR side of one criterion: replay the cached path, or explore and record (§19 3a–b). */
export async function recordWithPath<R>(deps: ReplayDeps<R>): Promise<ReplayOutcome<R>> {
  let take = 1;
  let broken: R | undefined;
  if (deps.cached) {
    const recording = await deps.record(deps.cached, take);
    if (!replayBroke(deps.laneOf(recording))) {
      return { kind: "recorded", recording, path: deps.cached, source: "cache", take };
    }
    broken = recording;
    take++;
  }
  // At most one exploration per criterion and job.
  const explored = await deps.explore();
  if (explored.status !== "found") {
    return { kind: "not_found", explored, ...(broken !== undefined && { recording: broken }) };
  }
  const recording = await deps.record(explored.path, take);
  return {
    kind: "recorded",
    recording,
    path: explored.path,
    source: broken === undefined ? "explored" : "re_explored",
    take,
    explored,
  };
}

/**
 * One job's view of the run group's path cache: seeded from the job's cachedPaths (saved by
 * earlier runs of the group for the same intent), updated as paths are explored or discarded.
 */
export class PathCache {
  readonly #paths = new Map<string, SavedPath>();

  constructor(paths: readonly SavedPath[] = []) {
    for (const path of paths) this.#paths.set(path.criterionId, path);
  }

  get(criterionId: string): SavedPath | null {
    return this.#paths.get(criterionId) ?? null;
  }

  put(path: SavedPath): void {
    this.#paths.set(path.criterionId, path);
  }

  discard(criterionId: string): void {
    this.#paths.delete(criterionId);
  }
}
