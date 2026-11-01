import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Browser } from "playwright";

import type { BoxSample } from "./boxes.ts";
import { ffmpegAsync } from "./ffmpeg.ts";
import { VIEWPORT } from "./lane.ts";

// The evidence GIF and still for a DOM target (ARCHITECTURE §23): the human video over the
// evidence window, the watched element outlined in red on every frame where the box track saw it,
// and a caption band above the page ("C2 ❌ The total stayed $50.00 after Apply"). Chromium draws
// the outline and the caption, as for the annotated still (no ffmpeg drawtext, §21.4); ffmpeg cuts
// the frames and encodes the GIF with its own palette. The still is the frame at Tt+1000.

/** GitHub shows inline images up to 10 MB; §23 keeps the GIF under 2 MB so the comment loads fast. */
export const MAX_GIF_BYTES = 2 * 1024 * 1024;
/** Frames are cut at this rate, then the GIF takes every one or fewer. */
const SOURCE_FPS = 10;
const CAPTION_BAND = 48;
const OUTLINE = "#FF3B30";
/** A box recorded this little after a frame still counts for it (frame timing jitter). */
const BOX_SLACK_MS = 50;

/** §23's size rule: lower the frame rate first, then the width, until the GIF fits. */
export function gifAttempts(): { fps: number; width: number }[] {
  return [
    { fps: 8, width: 640 },
    { fps: 6, width: 640 },
    { fps: 4, width: 640 },
    { fps: 4, width: 480 },
    { fps: 4, width: 360 },
  ];
}

/**
 * The label's box at `tMs` (canonical). The box track records a box only when it changes (boxes.ts),
 * so the box at a moment is the last one recorded at or before it, a few ms of frame jitter
 * allowed; a null sample means the element was gone.
 */
export function boxAt(
  track: readonly BoxSample[],
  label: string,
  tMs: number,
): [number, number, number, number] | null {
  let current: BoxSample | null = null;
  for (const sample of track) {
    if (sample.label !== label || sample.tMs > tMs + BOX_SLACK_MS) continue;
    if (!current || sample.tMs >= current.tMs) current = sample;
  }
  return current?.box ?? null;
}

/**
 * The watch label to outline over a window: the first, in track order, whose box shows at any
 * moment of it, a box held from before the window included. The track holds element watch targets
 * only (boxes.ts), so this is never a region.
 */
export function outlinedLabel(
  track: readonly BoxSample[],
  window: { startMs: number; endMs: number },
): string | null {
  const labels = [...new Set(track.map((b) => b.label))];
  return (
    labels.find(
      (label) =>
        boxAt(track, label, window.startMs) !== null ||
        track.some(
          (b) => b.label === label && b.box && b.tMs > window.startMs && b.tMs <= window.endMs,
        ),
    ) ?? null
  );
}

/** The GIF's caption: the criterion, its verdict and what the judges saw, on one short line. */
export function captionOf(
  criterionId: string,
  verdict: "pass" | "fail" | "inconclusive",
  observed: string,
): string {
  const icon = { pass: "✅", fail: "❌", inconclusive: "⚪" }[verdict];
  const line = observed.replace(/\s+/g, " ").trim();
  const text = line.length > 90 ? `${line.slice(0, 89)}…` : line;
  return `${criterionId} ${icon} ${text}`;
}

export interface EvidenceInput {
  /** human.mp4 (1280×720) and its offset: file ms = canonical ms + humanOffsetMs (§21.4). */
  humanVideo: string;
  humanOffsetMs: number;
  /** The verdict's evidence window, canonical (§22.3: from Tt, never from a judge's atMs). */
  window: { startMs: number; endMs: number };
  tTriggerMs: number;
  /** The recorder's box track and the watched element to outline; null outlines nothing. */
  boxTrack: readonly BoxSample[];
  label: string | null;
  caption: string;
  outDir: string;
}

export interface EvidenceOutput {
  gif: string;
  still: string;
  fps: number;
  width: number;
  bytes: number;
  /** Frames on which the element was outlined, of all frames. */
  outlined: number;
  frames: number;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

/** Renders the GIF and the still into outDir. */
export async function renderEvidence(
  browser: Browser,
  input: EvidenceInput,
): Promise<EvidenceOutput> {
  mkdirSync(input.outDir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "intenzo-evidence-"));
  try {
    // 1. The window's frames, cut from the human video at SOURCE_FPS.
    const fileStart = Math.max(0, input.window.startMs + input.humanOffsetMs);
    const seconds = Math.max(0.5, (input.window.endMs - input.window.startMs) / 1000);
    await ffmpegAsync(
      "-ss",
      (fileStart / 1000).toFixed(3),
      "-t",
      seconds.toFixed(3),
      "-i",
      input.humanVideo,
      "-vf",
      `fps=${SOURCE_FPS}`,
      join(work, "raw-%04d.png"),
    );
    const raws = readdirSync(work)
      .filter((f) => f.startsWith("raw-"))
      .sort();
    if (raws.length === 0) throw new Error("no frames in the evidence window");
    // The canonical time of the first frame (the window may start before the video does).
    const canonicalStart = fileStart - input.humanOffsetMs;

    // 2. Each frame drawn with the outline and the caption, by Chromium.
    const page = await browser.newPage({
      viewport: { width: VIEWPORT.width, height: VIEWPORT.height + CAPTION_BAND },
      deviceScaleFactor: 1,
    });
    let outlined = 0;
    try {
      await page.setContent(
        `<html><body style="margin:0;background:#111">` +
          `<div style="height:${CAPTION_BAND}px;background:#111;color:#fff;font:24px/${CAPTION_BAND}px Arial, sans-serif;padding:0 16px;white-space:nowrap;overflow:hidden">${escapeHtml(input.caption)}</div>` +
          `<div style="position:relative;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px">` +
          `<img id="f" style="position:absolute;left:0;top:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px">` +
          `<div id="b" style="position:absolute;display:none;border:2px solid ${OUTLINE};box-sizing:border-box"></div>` +
          `</div></body></html>`,
      );
      for (const [i, raw] of raws.entries()) {
        const tMs = canonicalStart + (i * 1000) / SOURCE_FPS;
        const box = input.label ? boxAt(input.boxTrack, input.label, tMs) : null;
        if (box) outlined++;
        const src = `data:image/png;base64,${readFileSync(join(work, raw)).toString("base64")}`;
        await page.evaluate(
          ([url, b]) => {
            const img = document.getElementById("f") as HTMLImageElement;
            const div = document.getElementById("b") as HTMLDivElement;
            img.src = url as string;
            const r = b as [number, number, number, number] | null;
            if (r) {
              // A 4 px margin, so the outline frames the element instead of covering its edge.
              div.style.cssText += `;display:block;left:${r[0] - 4}px;top:${r[1] - 4}px;width:${r[2] + 8}px;height:${r[3] + 8}px`;
            } else {
              div.style.display = "none";
            }
            return img.decode();
          },
          [src, box] as const,
        );
        await page.screenshot({ path: join(work, `ann-${String(i + 1).padStart(4, "0")}.png`) });
      }
    } finally {
      await page.close();
    }

    // 3. The still: the frame nearest Tt+1000.
    const stillIndex = Math.min(
      raws.length - 1,
      Math.max(0, Math.round(((input.tTriggerMs + 1000 - canonicalStart) * SOURCE_FPS) / 1000)),
    );
    const still = join(input.outDir, "evidence.png");
    copyFileSync(join(work, `ann-${String(stillIndex + 1).padStart(4, "0")}.png`), still);

    // 4. The GIF, smaller until it fits (§23).
    const gif = join(input.outDir, "evidence.gif");
    for (const { fps, width } of gifAttempts()) {
      await ffmpegAsync(
        "-framerate",
        String(SOURCE_FPS),
        "-i",
        join(work, "ann-%04d.png"),
        "-vf",
        `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`,
        "-loop",
        "0",
        gif,
      );
      const bytes = statSync(gif).size;
      if (bytes <= MAX_GIF_BYTES)
        return { gif, still, fps, width, bytes, outlined, frames: raws.length };
    }
    throw new Error(`the GIF stays over ${MAX_GIF_BYTES} bytes even at 4 fps and 360 px`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
