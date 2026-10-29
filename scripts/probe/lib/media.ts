import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

import { REPO_ROOT } from "./env.ts";
import { SPEECH } from "./questions.ts";

export const MEDIA_DIR = `${REPO_ROOT}probes/media/`;

/** Ground truth baked into the generated media; probes score model answers against it. */
export const TRUTH = {
  video: { width: 960, height: 540, fps: 10, seconds: 5, frames: 50, changeAtS: 2.5 },
  /** Solid red rectangle in cart.mp4 / cart.png (inclusive pixel coordinates, 960x540). */
  redBox: { x1: 620, y1: 300, x2: 819, y2: 419 },
  /** Blue "Apply" button in apply.png (inclusive pixel coordinates, 1280x720). */
  applyButton: { x1: 600, y1: 400, x2: 759, y2: 449 },
  /** Frames extracted for "frames mode" judging: before (50.00) and after (45.00) the change. */
  frameTimesS: [0.5, 1.5, 2.0, 3.0, 4.5],
} as const;

export interface Media {
  cartMp4: string;
  cartPng: string;
  frames: { path: string; atS: number }[];
  applyPng: string;
  speechWav: string;
  speechPcm24k: string;
}

const FONTS = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
];

/** Generates the probe media once (into probes/media/, gitignored) and returns the paths. */
export function ensureMedia(): Media {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const media: Media = {
    cartMp4: `${MEDIA_DIR}cart.mp4`,
    cartPng: `${MEDIA_DIR}cart.png`,
    frames: TRUTH.frameTimesS.map((atS) => ({ path: `${MEDIA_DIR}frame-${atS}s.jpg`, atS })),
    applyPng: `${MEDIA_DIR}apply.png`,
    speechWav: `${MEDIA_DIR}speech.wav`,
    speechPcm24k: `${MEDIA_DIR}speech-24k.pcm`,
  };

  if (!existsSync(media.cartMp4)) makeCartVideo(media.cartMp4);
  if (!existsSync(media.cartPng))
    ffmpeg("-ss", "1", "-i", media.cartMp4, "-frames:v", "1", media.cartPng);
  for (const { path, atS } of media.frames) {
    if (!existsSync(path))
      ffmpeg("-ss", String(atS), "-i", media.cartMp4, "-frames:v", "1", "-q:v", "3", path);
  }
  if (!existsSync(media.applyPng)) makeApplyScreenshot(media.applyPng);
  if (!existsSync(media.speechWav) || !existsSync(media.speechPcm24k)) makeSpeech(media);
  return media;
}

/** A 5 s, 10 fps "cart page": the total reads $50.00, then $45.00 from 2.5 s, plus a red box. */
function makeCartVideo(out: string): void {
  const { width, height, fps, seconds, changeAtS } = TRUTH.video;
  const { x1, y1, x2, y2 } = TRUTH.redBox;
  const filters = [
    text("Your cart", 60, 50, 48),
    text("Order total", 60, 200, 40),
    text("$50.00", 330, 200, 40, `:enable='lt(t,${changeAtS})'`),
    text("$45.00", 330, 200, 40, `:enable='gte(t,${changeAtS})'`),
    `drawbox=x=${x1}:y=${y1}:w=${x2 - x1 + 1}:h=${y2 - y1 + 1}:color=red:t=fill`,
  ].join(",");
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    `color=c=white:s=${width}x${height}:r=${fps}:d=${seconds}`,
    "-vf",
    filters,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    out,
  );
}

/** A 1280x720 checkout screen with a discount field and a blue "Apply" button. */
function makeApplyScreenshot(out: string): void {
  const { x1, y1, x2, y2 } = TRUTH.applyButton;
  const filters = [
    text("Checkout", 60, 50, 48),
    text("Discount code", 400, 340, 30),
    "drawbox=x=400:y=400:w=180:h=50:color=gray:t=2",
    `drawbox=x=${x1}:y=${y1}:w=${x2 - x1 + 1}:h=${y2 - y1 + 1}:color=0x2563EB:t=fill`,
    text("Apply", x1 + 42, y1 + 10, 30, ":fontcolor=white"),
  ].join(",");
  ffmpeg("-f", "lavfi", "-i", "color=c=white:s=1280x720", "-frames:v", "1", "-vf", filters, out);
}

/** The spoken ticket: 16 kHz WAV for file transcription, raw 24 kHz PCM16 for realtime. */
function makeSpeech(media: Media): void {
  const raw = `${MEDIA_DIR}speech-raw.aiff`;
  if (has("say")) {
    execFileSync("say", ["-o", raw, SPEECH]);
  } else if (has("espeak-ng")) {
    execFileSync("espeak-ng", ["-w", raw, SPEECH]);
  } else {
    throw new Error("probe media: need `say` (macOS) or `espeak-ng` to synthesize speech");
  }
  ffmpeg("-i", raw, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", media.speechWav);
  ffmpeg(
    "-i",
    raw,
    "-f",
    "s16le",
    "-ar",
    "24000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    media.speechPcm24k,
  );
}

function text(value: string, x: number, y: number, size: number, extra = ""): string {
  const font = FONTS.find((f) => existsSync(f));
  const fontfile = font ? `fontfile=${font}:` : "";
  // fontcolor may be overridden by `extra`; ffmpeg uses the last occurrence.
  return `drawtext=${fontfile}text='${value}':x=${x}:y=${y}:fontsize=${size}:fontcolor=black${extra}`;
}

function ffmpeg(...args: string[]): void {
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
    stdio: "inherit",
  });
}

function has(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
