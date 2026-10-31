// The navigator (ARCHITECTURE §20): from a criterion to a saved, replayable path. Exported
// separately from the package root because it drives a browser.
export {
  deniedTerm,
  guardAction,
  type GuardCode,
  type GuardContext,
  type GuardResult,
} from "./guard.ts";
export {
  durableTarget,
  estimateRoleName,
  isSameElement,
  regionWatchFor,
  type RoleName,
} from "./durable.ts";
export {
  explore,
  EXPLORE_BUDGET,
  HISTORY_WINDOW,
  NAVIGATOR_MODEL,
  startPathFor,
  type ExploreOptions,
  type ExploreResult,
  type ExploreStep,
} from "./explore.ts";
export { roleNameIn } from "./explore.ts";
export {
  PathCache,
  recordWithPath,
  replayBroke,
  type ReplayDeps,
  type ReplayOutcome,
} from "./replay.ts";
