import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { CriterionId, type LoggedStep, type StepLogEntry, type Target } from "../schema/index.ts";
import { MARKER_MS } from "./clock.ts";

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
/** A frame with less marker green than this is past the marker. */
const MARKER_GONE = 0.05;
/** Give up looking for the marker's end this long after it started, and cut by the clock. */
const MARKER_SEARCH_MS = 3000;

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

/** "click: Apply", "fill: Discount code = "SAVE10"", "press: Enter (failed)". */
export function captionText(entry: Pick<StepLogEntry, "step" | "ok">): string {
  const text = describeStep(entry.step);
  return entry.ok ? text : `${text} (failed)`;
}

export function describeStep(step: LoggedStep): string {
  switch (step.op) {
    case "goto":
      return `goto: ${step.path}`;
    case "click":
      return `click: ${describeTarget(step.target)}`;
    case "fill":
      return `fill: ${describeTarget(step.target)} = ${typed(step.target, step.value)}`;
    case "select":
      return `select: ${describeTarget(step.target)} = ${typed(step.target, step.option)}`;
    case "press":
      return `press: ${step.key}`;
    case "scroll":
      return step.target
        ? `scroll ${step.direction}: ${describeTarget(step.target)}`
        : `scroll ${step.direction}`;
    case "wait":
      return `wait: ${step.ms} ms`;
    case "back":
      return "back";
    case "reload":
      return "reload";
  }
}

export function describeTarget(target: Target): string {
  switch (target.by) {
    case "role":
      return clip(target.name || target.role);
    case "testId":
      return clip(`testid ${target.id}`);
    case "label":
    case "placeholder":
      return clip(target.text);
    case "css":
      return clip(target.selector);
    case "point":
      return `(${Math.round(target.x)}, ${Math.round(target.y)})`;
  }
}

const SECRET_FIELD = /pass(word|code)?|secret|token|otp|\bpin\b|cvv|cvc/i;

/** What a fill or select typed, hidden when the field looks like a secret: videos get shared. */
function typed(target: Target, value: string): string {
  return SECRET_FIELD.test(describeTarget(target)) ? '"••••••"' : `"${clip(value)}"`;
}

function clip(text: string, max = 48): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
