import { execFileSync } from "node:child_process";

// Thin ffmpeg/ffprobe wrappers. Only decoding and encoding: text is never drawn with ffmpeg's
// drawtext, since some builds (Homebrew's) lack freetype (ARCHITECTURE §21.4).

const TINY = { width: 16, height: 9 } as const;

export function ffmpeg(...args: string[]): void {
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: "pipe" });
}

/** Every decoded frame's presentation time in ms (Playwright videos are variable frame rate). */
export function frameTimesMs(video: string): number[] {
  const out = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v",
      "-show_entries",
      "frame=pts_time",
      "-of",
      "csv=p=0",
      video,
    ],
    { encoding: "utf8" },
  );
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "N/A")
    .map((s) => Math.round(Number(s) * 1000));
}

/** Every frame downscaled to 16×9 RGB, in the same order as frameTimesMs. */
export function tinyFrames(video: string): Buffer[] {
  const raw = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      video,
      "-vf",
      `scale=${TINY.width}:${TINY.height}`,
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  const size = TINY.width * TINY.height * 3;
  const frames: Buffer[] = [];
  for (let at = 0; at + size <= raw.length; at += size) frames.push(raw.subarray(at, at + size));
  return frames;
}

export type Rgb = [number, number, number];

/** The share of a frame's pixels that pass `test`. */
export function pixelShare(frame: Buffer, test: (rgb: Rgb) => boolean): number {
  let hits = 0;
  const pixels = frame.length / 3;
  for (let i = 0; i < frame.length; i += 3) {
    if (test([frame[i]!, frame[i + 1]!, frame[i + 2]!])) hits++;
  }
  return hits / pixels;
}

/** The marker's colour after VP8 compression: G > 200 with R and B < 80 (§21.4). */
export const isMarkerGreen = ([r, g, b]: Rgb): boolean => g > 200 && r < 80 && b < 80;

/** Video time (ms) of the first frame that's ≥ 90 % marker green, or null if there's none. */
export function findFirstFrameMs(video: string, test = isMarkerGreen, share = 0.9): number | null {
  const times = frameTimesMs(video);
  const frames = tinyFrames(video);
  const n = Math.min(times.length, frames.length);
  for (let i = 0; i < n; i++) {
    if (pixelShare(frames[i]!, test) >= share) return times[i]!;
  }
  return null;
}
