// Browser-side helpers (Playwright). Exported separately from the package root so code that
// doesn't drive a browser (e.g. Intenzo Cloud) never loads Playwright.
export { hookHeaders, signHookCall } from "./hooks.ts";
export {
  acquireIdentity,
  HookError,
  openLane,
  originOf,
  VIEWPORT,
  type IdentityOptions,
  type Lane,
  type LaneOptions,
} from "./lane.ts";
