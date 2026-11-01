import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { CriterionId, type StepLogEntry } from "../schema/index.ts";
import { describeStep } from "../report/steps.ts";
import { MARKER_MS } from "./clock.ts";
import { ffmpegAsync, frameTimesMs, isMarkerGreen, pixelShare, tinyFrames } from "./ffmpeg.ts";

// The two videos a lane leaves behind (ARCHITECTURE §21.4), cut and encoded from Playwright's raw
// 1280×720 recording:
// - human.mp4: what a person watches. Full size and frame rate, the sync marker cut out, and a
//   caption for each step of the step log.
// - judge.mp4: what the judges watch. 960×540 at 4 fps, with each frame's canonical time burned
//   into a 40 px band under the page, never over it (in T0.3 a corner stamp covered the toast).
// Text is drawn by Chromium, never by ffmpeg's drawtext (Homebrew's ffmpeg may lack freetype);
// ffmpeg only shifts, samples, scales, overlays and encodes. Each file has its own exact offset:
// file ms = canonical ms + offsetMs.

export const HUMAN_VIDEO = { width: 1280, height: 720 } as const;
export const JUDGE_VIDEO = { width: 960, height: 540, band: 40, fps: 4 } as const;
/** How long a step's caption stays on screen. */
export const CAPTION_MS = 1500;
/** At most this many captions are stacked at once (the newest at the bottom). */
export const MAX_CAPTION_LINES = 3;
const JUDGE_FRAME_MS = 1000 / JUDGE_VIDEO.fps;
const CAPTION_MARGIN = 24;
/** A frame with less marker green than this is past the marker. */
const MARKER_GONE = 0.05;
/** Give up looking for the marker's end this long after it started, and cut by the clock. */
const MARKER_SEARCH_MS = 3000;

export interface VideoInput {
  /** The lane's raw 1280×720 webm (Playwright recordVideo). */
  rawVideo: string;
  /** Canonical ms → raw video ms (alignVideo's offsetMs). */
  rawOffsetMs: number;
  /** Canonical ms the sync marker was first painted, if it was shown: it's cut from both videos. */
  markerShownAt: number | null;
  /** Step captions; tMs is canonical. */
  stepLog: readonly StepLogEntry[];
  /** Canonical; the judge video's timestamps count from here. */
  laneStartMs: number;
  /** The take directory; gets human.mp4 and judge.mp4. */
  outDir: string;
}

export interface VideoOutputs {
  /** offsetMs: canonical ms → this file's ms (lane.videoOffsets.human). */
  human: { path: string; offsetMs: number };
  /** offsetMs: canonical ms → this file's ms (lane.videoOffsets.judge). */
  judge: { path: string; offsetMs: number };
}

/** Renders human.mp4 and judge.mp4 into outDir. Pass a browser to reuse it for drawing the text. */
export async function renderVideos(
  input: VideoInput,
  options: { browser?: Browser } = {},
): Promise<VideoOutputs> {
  const { rawVideo, rawOffsetMs, markerShownAt, stepLog, laneStartMs, outDir } = input;
  const times = frameTimesMs(rawVideo);
  if (times.length === 0) throw new Error(`the raw video has no frames: ${rawVideo}`);
  const markerVideoMs = markerShownAt === null ? null : markerShownAt + rawOffsetMs;
  const greens =
    markerVideoMs === null ? [] : tinyFrames(rawVideo).map((f) => pixelShare(f, isMarkerGreen));
  const cutMs = cutAfterMarker(times, greens, markerVideoMs);

  const humanOffsetMs = rawOffsetMs - cutMs;
  const timeline = judgeTimeline(cutMs - rawOffsetMs, laneStartMs);
  const judgeRawStartMs = timeline.startCanonical + rawOffsetMs;
  const lastFrameMs = times.at(-1)! + (times.length > 1 ? times.at(-1)! - times.at(-2)! : 40);
  const judgeFrames = Math.max(1, Math.ceil((lastFrameMs - judgeRawStartMs) / JUDGE_FRAME_MS) + 2);

  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "intenzo-video-"));
  const browser = options.browser ?? (await chromium.launch());
  try {
    const spans = captionSpans(stepLog, humanOffsetMs);
    const page = await browser.newPage({ viewport: HUMAN_VIDEO, deviceScaleFactor: 1 });
    let captions: string[];
    try {
      captions = await drawCaptions(page, spans, work);
      await drawStamps(page, timeline.firstSlot, judgeFrames, work);
    } finally {
      await page.close();
    }
    const human = join(outDir, "human.mp4");
    const judge = join(outDir, "judge.mp4");
    await Promise.all([
      encodeHuman(rawVideo, cutMs, spans, captions, human),
      encodeJudge(rawVideo, judgeRawStartMs, join(work, "stamp-%05d.png"), judge),
    ]);
    return {
      human: { path: human, offsetMs: humanOffsetMs },
      judge: { path: judge, offsetMs: timeline.offsetMs },
    };
  } finally {
    if (!options.browser) await browser.close();
    rmSync(work, { recursive: true, force: true });
  }
}

/** Creates and returns root/{criterionId}/{side}/take-{n} with the next free n (§28). */
export function nextTakeDir(root: string, criterionId: string, side: "pr" | "base"): string {
  const sideDir = join(root, CriterionId.parse(criterionId), side);
  mkdirSync(sideDir, { recursive: true });
  const taken = readdirSync(sideDir).flatMap((name) => {
    const n = /^take-(\d+)$/.exec(name)?.[1];
    return n ? [Number(n)] : [];
  });
  // mkdir without `recursive` fails on an existing folder, so two lanes racing for the same n
  // can't share it: the loser moves on to the next one.
  for (let n = Math.max(0, ...taken) + 1; ; n++) {
    const dir = join(sideDir, `take-${n}`);
    try {
      mkdirSync(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

// ── Timing (pure) ───────────────────────────────────────────────────────────────────────────────

/**
 * Raw video ms where both videos start: the first frame after the marker has gone. Frames before
 * half the marker's run are never taken, so a marker time estimated from the trace (±1 frame)
 * still can't start the video on the marker. Without a marker, the video starts at its first frame.
 */
export function cutAfterMarker(
  times: readonly number[],
  greenShares: readonly number[],
  markerVideoMs: number | null,
): number {
  if (times.length === 0) throw new Error("no frames");
  if (markerVideoMs === null) return times[0]!;
  const earliest = markerVideoMs + MARKER_MS / 2;
  const cleared = times.findIndex(
    (t, i) =>
      t >= earliest && t <= markerVideoMs + MARKER_SEARCH_MS && greenShares[i]! < MARKER_GONE,
  );
  if (cleared !== -1) return times[cleared]!;
  // The marker never visibly ended (the page itself is marker green?): cut by the clock.
  return times.find((t) => t >= markerVideoMs + MARKER_MS + 100) ?? times.at(-1)!;
}

export interface JudgeTimeline {
  /** Slot n of the 250 ms grid counted from the lane start is canonical laneStartMs + n × 250. */
  firstSlot: number;
  /** Canonical time of the judge video's first frame. */
  startCanonical: number;
  /** Canonical ms → judge file ms. */
  offsetMs: number;
}

/**
 * The judge video samples canonical time on a 250 ms grid counted from the lane start, from the
 * first grid point at or after `fromCanonical`, so its stamps read t=12.250s, never t=12.237s.
 */
export function judgeTimeline(fromCanonical: number, laneStartMs: number): JudgeTimeline {
  // The epsilon keeps float noise (1000.0000001 ms) from skipping a whole slot.
  const firstSlot = Math.ceil((fromCanonical - laneStartMs) / JUDGE_FRAME_MS - 1e-6);
  const startCanonical = laneStartMs + firstSlot * JUDGE_FRAME_MS;
  return { firstSlot, startCanonical, offsetMs: -startCanonical };
}

/** "t=12.250s": ms since the lane start, as burned into the judge video's band. */
export function formatStamp(ms: number): string {
  const rounded = Math.round(ms);
  const sign = rounded < 0 ? "-" : "";
  return `t=${sign}${(Math.abs(rounded) / 1000).toFixed(3)}s`;
}

export interface CaptionLine {
  text: string;
  /** A trigger step (the last one's time is Tt), drawn with an accent. */
  trigger: boolean;
  ok: boolean;
}

export interface CaptionSpan {
  /** File ms, [fromMs, toMs). */
  fromMs: number;
  toMs: number;
  lines: CaptionLine[];
}

/**
 * When each caption is on screen, in file ms. Every step's caption shows for CAPTION_MS from its
 * time. Steps close together (fill, then click) stack instead of cutting each other short, so
 * each stays readable; the output is the run of distinct stacks.
 */
export function captionSpans(stepLog: readonly StepLogEntry[], offsetMs: number): CaptionSpan[] {
  const windows = stepLog
    .map((entry) => ({
      from: entry.tMs + offsetMs,
      to: entry.tMs + offsetMs + CAPTION_MS,
      line: { text: captionText(entry), trigger: entry.trigger, ok: entry.ok },
    }))
    .sort((a, b) => a.from - b.from);
  const edges = [...new Set(windows.flatMap((w) => [w.from, w.to]))].sort((a, b) => a - b);
  const spans: CaptionSpan[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const [from, to] = [edges[i]!, edges[i + 1]!];
    if (to <= 0) continue; // before the cut
    const lines = windows.filter((w) => w.from <= from && w.to >= to).map((w) => w.line);
    if (lines.length > 0) {
      spans.push({ fromMs: Math.max(0, from), toMs: to, lines: lines.slice(-MAX_CAPTION_LINES) });
    }
  }
  return spans;
}

export { describeStep, describeTarget } from "../report/steps.ts";

/** "click: Apply", "fill: Discount code = "SAVE10"", "press: Enter (failed)". */
export function captionText(entry: Pick<StepLogEntry, "step" | "ok">): string {
  const text = describeStep(entry.step);
  return entry.ok ? text : `${text} (failed)`;
}

// ── Drawing (Chromium) and encoding (ffmpeg) ────────────────────────────────────────────────────

/** One transparent PNG per caption span, sized to its stack of captions. */
async function drawCaptions(page: Page, spans: readonly CaptionSpan[], work: string) {
  const files: string[] = [];
  for (const [n, span] of spans.entries()) {
    await page.setContent(
      '<body style="margin:0; background:transparent"><div id="c"></div></body>',
    );
    await page.evaluate(
      ({ lines, maxWidth }) => {
        const stack = document.getElementById("c")!;
        stack.style.cssText = `display:inline-flex; flex-direction:column; align-items:flex-start; gap:6px; max-width:${maxWidth}px`;
        lines.forEach((line, i) => {
          const tag = document.createElement("div");
          tag.textContent = line.text; // text, never HTML: step values come from the page
          const accent = !line.ok ? "#ef4444" : line.trigger ? "#f59e0b" : "#60a5fa";
          tag.style.cssText = `font:600 26px/38px Arial, Helvetica, sans-serif; color:#fff; background:rgba(17,24,39,.88); border-left:6px solid ${accent}; border-radius:8px; padding:2px 16px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; box-sizing:border-box; opacity:${i === lines.length - 1 ? 1 : 0.75}`;
          stack.append(tag);
        });
      },
      { lines: span.lines, maxWidth: HUMAN_VIDEO.width - 2 * CAPTION_MARGIN },
    );
    const file = join(work, `caption-${n}.png`);
    await page.locator("#c").screenshot({ path: file, omitBackground: true });
    files.push(file);
  }
  return files;
}

/** stamp-00000.png…: the band under judge frame n, with its time since the lane start. */
async function drawStamps(page: Page, firstSlot: number, count: number, work: string) {
  const { width, band } = JUDGE_VIDEO;
  await page.setViewportSize({ width, height: band });
  await page.setContent(
    `<body style="margin:0; background:#000"><div id="t" style="width:${width}px; height:${band}px; font:600 24px/${band}px Menlo, Consolas, 'DejaVu Sans Mono', monospace; color:#fff; text-align:center"></div></body>`,
  );
  for (let n = 0; n < count; n++) {
    const stamp = formatStamp((firstSlot + n) * JUDGE_FRAME_MS);
    await page.evaluate((text) => (document.getElementById("t")!.textContent = text), stamp);
    await page.screenshot({ path: join(work, `stamp-${String(n).padStart(5, "0")}.png`) });
  }
}

const seconds = (ms: number) => (ms / 1000).toFixed(6);
/** Shifts a stream so raw ms `ms` becomes 0, rounded to the nearest tick (setpts truncates). */
const shiftTo = (ms: number) => `setpts=round(PTS-${seconds(ms)}/TB)`;
const H264 = ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"];
// Keep every frame's timestamp as the filters set it: the offsets depend on it.
const MP4 = ["-fps_mode", "passthrough", "-movflags", "+faststart"];

function encodeHuman(
  raw: string,
  cutMs: number,
  spans: readonly CaptionSpan[],
  captions: readonly string[],
  out: string,
): Promise<void> {
  const graph = [`[0:v]${shiftTo(cutMs)},trim=start=0[v0]`];
  spans.forEach((span, i) => {
    const on = `gte(t,${seconds(span.fromMs)})*lt(t,${seconds(span.toMs)})`;
    const at = `x=${CAPTION_MARGIN}:y=main_h-overlay_h-${CAPTION_MARGIN}`;
    graph.push(`[v${i}][${i + 1}:v]overlay=${at}:enable='${on}'[v${i + 1}]`);
  });
  graph.push(`[v${spans.length}]format=yuv420p[out]`);
  const inputs = captions.flatMap((file) => ["-i", file]);
  // prettier-ignore
  return ffmpegAsync("-i", raw, ...inputs, "-filter_complex", graph.join(";"), "-map", "[out]", ...H264, ...MP4, out);
}

function encodeJudge(raw: string, startMs: number, stamps: string, out: string): Promise<void> {
  const { width, height, band, fps } = JUDGE_VIDEO;
  // fps with round=up shows, at each slot, the last raw frame at or before the slot's time:
  // exactly what was on screen at that canonical time.
  const graph = [
    `[0:v]${shiftTo(startMs)},fps=fps=${fps}:start_time=0:round=up,scale=${width}:${height},pad=${width}:${height + band}:0:0:color=black[page]`,
    `[page][1:v]overlay=x=0:y=${height}:shortest=1,format=yuv420p[out]`,
  ];
  // prettier-ignore
  return ffmpegAsync("-i", raw, "-framerate", String(fps), "-start_number", "0", "-i", stamps, "-filter_complex", graph.join(";"), "-map", "[out]", ...H264, ...MP4, out);
}
