import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { Browser } from "playwright";

import { ffmpeg } from "../../probe/lib/media.ts";
import { SHOT_OFFSET_MS, VIEWPORT } from "./record.ts";
import type { Lane } from "./schema.ts";

// Text is drawn by Chromium, not by ffmpeg's drawtext: Homebrew's slim ffmpeg is built without
// freetype, so drawtext isn't available everywhere. ffmpeg only cuts frames and encodes them.
// Nothing drawn here may cover the page: the time goes in a band under each frame, and the labels
// in a column right of the screenshot.

/** §14 MediaEncoder `video` mode for the page area; the time band adds STAMP_BAND px below it. */
export const JUDGE_VIDEO = { width: 960, height: 540, fps: 4 } as const;
export const STAMP_BAND = 40;
export const LABEL_COLUMN = 300;
const TAG_HEIGHT = 34;
const TEXT = "font:24px/34px Arial, sans-serif; color:#fff; white-space:nowrap;";

type Size = { width: number; height: number };

export interface LabelledBox {
  label: string;
  /** x, y, width, height in screenshot pixels. */
  bbox: readonly [number, number, number, number];
}

/** Frame n of the judge clip shows lane time n × 250 ms (the raw video starts with the page). */
export const frameTimeMs = (n: number): number => Math.round((n * 1000) / JUDGE_VIDEO.fps);

/** A judge clip frame with the lane time burned in below the page (§21.4). */
export function stampHtml(frameUrl: string, tMs: number): string {
  const { width, height } = JUDGE_VIDEO;
  const band = `<div style="position:absolute; left:0; top:${height}px; width:${width}px; height:${STAMP_BAND}px; background:#000; text-align:center; ${TEXT} line-height:${STAMP_BAND}px">t=${tMs} ms</div>`;
  return canvas(frameUrl, { width, height }, { width, height: height + STAMP_BAND }, band);
}

/** Where each label sits in the column: level with its box, pushed down so tags never overlap. */
export function labelSlots(boxes: readonly LabelledBox[]): { box: LabelledBox; top: number }[] {
  let free = 0;
  return [...boxes]
    .sort((a, b) => a.bbox[1] - b.bbox[1])
    .map((box) => {
      const top = Math.max(free, Math.round(box.bbox[1] + box.bbox[3] / 2 - TAG_HEIGHT / 2));
      free = top + TAG_HEIGHT + 6;
      return { box, top };
    });
}

/** The Tt+1000 screenshot with every watched element boxed and labelled (§21.3 step 9, §22.2). */
export function annotateHtml(shotUrl: string, boxes: readonly LabelledBox[]): string {
  const { width, height } = VIEWPORT;
  const columnX = width + 16;
  const slots = labelSlots(boxes);
  const frames = slots.map(
    ({
      box: {
        bbox: [x, y, w, h],
      },
    }) => {
      const place = `left:${x - 4}px; top:${y - 4}px; width:${w + 8}px; height:${h + 8}px`;
      return `<div style="position:absolute; ${place}; box-sizing:border-box; border:4px solid red"></div>`;
    },
  );
  const lines = slots.map(
    ({
      box: {
        bbox: [x, y, w, h],
      },
      top,
    }) => {
      const ends = `x1="${x + w + 4}" y1="${y + h / 2}" x2="${columnX}" y2="${top + TAG_HEIGHT / 2}"`;
      return `<line ${ends} stroke="red" stroke-width="2" stroke-dasharray="6 4"/>`;
    },
  );
  const tags = slots.map(({ box: { label }, top }) => {
    const place = `left:${columnX}px; top:${top}px; height:${TAG_HEIGHT}px; padding:0 8px`;
    return `<div style="position:absolute; ${place}; background:red; ${TEXT}">${escapeHtml(label)}</div>`;
  });
  const column = `<div style="position:absolute; left:${width}px; top:0; width:${LABEL_COLUMN}px; height:${height}px; background:#f3f4f6; border-left:2px solid #9ca3af"></div>`;
  const svg = `<svg width="${width + LABEL_COLUMN}" height="${height}" style="position:absolute; left:0; top:0">${lines.join("")}</svg>`;
  const size = { width: width + LABEL_COLUMN, height };
  return canvas(shotUrl, VIEWPORT, size, column + frames.join("") + svg + tags.join(""));
}

/** The watched elements as they were boxed when the screenshot was taken (the Tt+1000 readings). */
export function boxesAtShot(lane: Lane): LabelledBox[] {
  const seen = new Set<string>();
  const boxes: LabelledBox[] = [];
  for (const r of lane.readings) {
    if (r.phase !== "post" || r.tMs < lane.tTriggerMs + SHOT_OFFSET_MS || seen.has(r.label))
      continue;
    seen.add(r.label); // an element absent at Tt+1000 gets no box, even if it shows up later
    if (r.bbox) boxes.push({ label: r.label, bbox: r.bbox });
  }
  return boxes;
}

/** Raw 1280×720 recording → the judge clip: 960×540 at 4 fps + the time band, H.264. */
export async function encodeJudgeVideo(
  browser: Browser,
  rawWebm: string,
  out: string,
  workDir: string,
): Promise<void> {
  const { width, height, fps } = JUDGE_VIDEO;
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const frame = join(workDir, "f-%04d.png");
  ffmpeg("-i", rawWebm, "-vf", `setpts=PTS-STARTPTS,fps=${fps},scale=${width}:${height}`, frame);
  const page = await browser.newPage({ viewport: { width, height: height + STAMP_BAND } });
  try {
    const files = readdirSync(workDir).filter((f) => f.endsWith(".png"));
    for (const [n, name] of files.sort().entries()) {
      const path = join(workDir, name);
      await page.setContent(stampHtml(pngDataUrl(path), frameTimeMs(n)));
      await page.screenshot({ path });
    }
  } finally {
    await page.close();
  }
  // prettier-ignore
  ffmpeg("-framerate", String(fps), "-i", frame, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out);
  rmSync(workDir, { recursive: true, force: true });
}

export async function annotateShot(
  browser: Browser,
  shotPng: string,
  boxes: readonly LabelledBox[],
  out: string,
): Promise<void> {
  const page = await browser.newPage({
    viewport: { width: VIEWPORT.width + LABEL_COLUMN, height: VIEWPORT.height },
  });
  try {
    await page.setContent(annotateHtml(pngDataUrl(shotPng), boxes));
    await page.screenshot({ path: out });
  } finally {
    await page.close();
  }
}

function canvas(imageUrl: string, image: Size, size: Size, overlay: string): string {
  const place = `position:relative; width:${size.width}px; height:${size.height}px; background:#fff`;
  const img = `<img src="${imageUrl}" style="position:absolute; left:0; top:0; width:${image.width}px; height:${image.height}px">`;
  return `<body style="margin:0"><div style="${place}">${img}${overlay}</div></body>`;
}

function escapeHtml(text: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  };
  return text.replace(/[&<>"]/g, (c) => entities[c]!);
}

const pngDataUrl = (path: string): string =>
  `data:image/png;base64,${readFileSync(path).toString("base64")}`;
