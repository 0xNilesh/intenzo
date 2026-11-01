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
  boxAt,
  captionOf,
  gifAttempts,
  MAX_GIF_BYTES,
  outlinedLabel,
  renderEvidence,
  type EvidenceInput,
  type EvidenceOutput,
} from "./evidence.ts";
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
export { QUIET_MS, SETTLE_CAP_MS, Settler, type Settled, type SettleOptions } from "./settle.ts";
export {
  annotateHtml,
  annotateShot,
  LABEL_COLUMN,
  labelSlots,
  type LabelledBox,
} from "./annotate.ts";
export {
  POST_OFFSETS_MS,
  postOffsets,
  recordCriterion,
  SHOT_OFFSET_MS,
  STEP_TIMEOUT_MS,
  type RecordOptions,
  type Recording,
} from "./record.ts";
export { ffmpegAsync, parseRate, probeVideo, type VideoProbe } from "./ffmpeg.ts";
export {
  CAPTION_MS,
  captionSpans,
  captionText,
  cutAfterMarker,
  describeStep,
  describeTarget,
  formatStamp,
  HUMAN_VIDEO,
  JUDGE_VIDEO,
  judgeTimeline,
  MAX_CAPTION_LINES,
  nextTakeDir,
  renderVideos,
  type CaptionLine,
  type CaptionSpan,
  type JudgeTimeline,
  type VideoInput,
  type VideoOutputs,
} from "./video.ts";
export {
  buildOutline,
  LIST_KEEP,
  OUTLINE_MAX_TOKENS,
  refLocator,
  renderOutline,
  type Outline,
  type OutlineOptions,
} from "./outline.ts";
