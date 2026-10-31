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
  isSameElement,
  regionWatchFor,
  estimateRoleName,
  type RoleName,
} from "./durable.ts";
