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
export { alignVideo, firstScreencastWallTime, type AlignInput, type Alignment } from "./align.ts";
export { MARKER_MS, now, pageNow, showSyncMarker } from "./clock.ts";
export {
  findFirstFrameMs,
  frameTimesMs,
  isMarkerGreen,
  pixelShare,
  tinyFrames,
  type Rgb,
} from "./ffmpeg.ts";
export { BoxPoller, type BoxSample } from "./boxes.ts";
export {
  LIVE_REGIONS,
  liveRegionLines,
  locate,
  Reader,
  readElement,
  snapshotRegion,
  type Phase,
} from "./readings.ts";
export { diffLines, NO_CHANGE, snapshotLines } from "./regions.ts";
