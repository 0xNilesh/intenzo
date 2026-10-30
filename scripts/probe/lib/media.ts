import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

import { chromium, type Browser } from "playwright";

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

/**
 * Generates the probe media once (into probes/media/, gitignored) and returns the paths. Chromium
 * draws the text (Homebrew's ffmpeg has no drawtext filter); ffmpeg only encodes.
 */
export async function ensureMedia(): Promise<Media> {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const media: Media = {
    cartMp4: `${MEDIA_DIR}cart.mp4`,
    cartPng: `${MEDIA_DIR}cart.png`,
    frames: TRUTH.frameTimesS.map((atS) => ({ path: `${MEDIA_DIR}frame-${atS}s.jpg`, atS })),
    applyPng: `${MEDIA_DIR}apply.png`,
    speechWav: `${MEDIA_DIR}speech.wav`,
    speechPcm24k: `${MEDIA_DIR}speech-24k.pcm`,
  };

  const needsBrowser = !existsSync(media.cartMp4) || !existsSync(media.applyPng);
  const browser = needsBrowser ? await chromium.launch() : undefined;
  try {
    if (!existsSync(media.cartMp4)) await makeCartVideo(browser!, media.cartMp4);
    if (!existsSync(media.applyPng))
      await renderPng(browser!, applyHtml(), 1280, 720, media.applyPng);
  } finally {
    await browser?.close();
  }
  if (!existsSync(media.cartPng))
    ffmpeg("-ss", "1", "-i", media.cartMp4, "-frames:v", "1", media.cartPng);
  for (const { path, atS } of media.frames) {
    if (!existsSync(path))
      ffmpeg("-ss", String(atS), "-i", media.cartMp4, "-frames:v", "1", "-q:v", "3", path);
  }
  if (!existsSync(media.speechWav) || !existsSync(media.speechPcm24k)) makeSpeech(media);
  return media;
}

/** A 5 s, 10 fps "cart page": the total reads $50.00, then $45.00 from 2.5 s, plus a red box. */
async function makeCartVideo(browser: Browser, out: string): Promise<void> {
  const { width, height, fps, frames, changeAtS } = TRUTH.video;
  const before = `${MEDIA_DIR}cart-before.png`;
  const after = `${MEDIA_DIR}cart-after.png`;
  await renderPng(browser, cartHtml("$50.00"), width, height, before);
  await renderPng(browser, cartHtml("$45.00"), width, height, after);
  const rest = String(TRUTH.video.seconds - changeAtS);
  // prettier-ignore
  ffmpeg(
    "-loop", "1", "-framerate", String(fps), "-t", String(changeAtS), "-i", before,
    "-loop", "1", "-framerate", String(fps), "-t", rest, "-i", after,
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]", "-map", "[v]",
    "-r", String(fps), "-frames:v", String(frames), "-c:v", "libx264", "-movflags", "+faststart", out,
  );
}

const at = (x: number, y: number, size: number, extra = "") =>
  `position:absolute;left:${x}px;top:${y}px;font:${size}px Arial,Helvetica,sans-serif;${extra}`;
const box = (b: { x1: number; y1: number; x2: number; y2: number }, extra: string) =>
  `position:absolute;left:${b.x1}px;top:${b.y1}px;width:${b.x2 - b.x1 + 1}px;height:${b.y2 - b.y1 + 1}px;${extra}`;
const page = (body: string) => `<body style="margin:0;background:#fff">${body}</body>`;

/** The cart frame showing `total`, with the red box at TRUTH.redBox (960x540). */
export function cartHtml(total: string): string {
  return page(
    `<div style="${at(60, 50, 48)}">Your cart</div>` +
      `<div style="${at(60, 200, 40)}">Order total</div>` +
      `<div style="${at(330, 200, 40)}">${total}</div>` +
      `<div style="${box(TRUTH.redBox, "background:#ff0000")}"></div>`,
  );
}

/** A checkout screen with a discount field and the blue Apply button at TRUTH.applyButton (1280x720). */
export function applyHtml(): string {
  return page(
    `<div style="${at(60, 50, 48)}">Checkout</div>` +
      `<div style="${at(400, 340, 30)}">Discount code</div>` +
      `<div style="${box({ x1: 400, y1: 400, x2: 579, y2: 449 }, "box-sizing:border-box;border:2px solid #808080")}"></div>` +
      `<div style="${box(TRUTH.applyButton, "background:#2563eb;color:#fff;font:30px Arial,Helvetica,sans-serif;display:flex;align-items:center;justify-content:center")}">Apply</div>`,
  );
}

/** Renders HTML to a PNG of exactly width x height. */
export async function renderPng(
  browser: Browser,
  html: string,
  width: number,
  height: number,
  out: string,
): Promise<void> {
  const tab = await browser.newPage({ viewport: { width, height } });
  try {
    await tab.setContent(html);
    await tab.screenshot({ path: out });
  } finally {
    await tab.close();
  }
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

export function ffmpeg(...args: string[]): void {
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
