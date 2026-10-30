import { readFileSync } from "node:fs";

import type { Browser } from "playwright";

import { VIEWPORT } from "./lane.ts";

// The annotated screenshot (§21.3 step 9, §22.2 item 3): the plain Tt+1000 screenshot with every
// watch target boxed in red and labelled, so the judges can say whether these are the right
// elements. It's drawn OFFLINE from the readings' bboxes, so nothing is ever drawn into the page or
// its video. Chromium draws it, as in scripts/gonogo/lib/encode.ts: Homebrew's ffmpeg has no
// drawtext, and this needs no image library. The labels go in a column right of the screenshot,
// never over the page.

export const LABEL_COLUMN = 300;
const TAG_HEIGHT = 34;
const TAG_GAP = 6;
const TEXT = "font:24px/34px Arial, sans-serif; color:#fff; white-space:nowrap;";

export interface LabelledBox {
  label: string;
  /** x, y, width, height in screenshot pixels. */
  bbox: readonly [number, number, number, number];
}

/** Where each label sits in the column: level with its box, pushed down so tags never overlap. */
export function labelSlots(boxes: readonly LabelledBox[]): { box: LabelledBox; top: number }[] {
  let free = 0;
  return (
    [...boxes]
      // By centre, so a box nested in a taller one (a total inside its summary) gets its tag first
      // when its centre is higher, and the leader lines don't cross.
      .sort((a, b) => a.bbox[1] + a.bbox[3] / 2 - (b.bbox[1] + b.bbox[3] / 2))
      .map((box) => {
        const top = Math.max(free, Math.round(box.bbox[1] + box.bbox[3] / 2 - TAG_HEIGHT / 2));
        free = top + TAG_HEIGHT + TAG_GAP;
        return { box, top };
      })
  );
}

/** The page that draws the annotation: the screenshot, red boxes, leader lines and tags. */
export function annotateHtml(shotUrl: string, boxes: readonly LabelledBox[]): string {
  const { width, height } = VIEWPORT;
  const columnX = width + 16;
  const slots = labelSlots(boxes);
  const frames = slots.map(({ box: { bbox } }) => {
    const [x, y, w, h] = bbox;
    const place = `left:${x - 4}px; top:${y - 4}px; width:${w + 8}px; height:${h + 8}px`;
    return `<div style="position:absolute; ${place}; box-sizing:border-box; border:4px solid red"></div>`;
  });
  const lines = slots.map(({ box: { bbox }, top }) => {
    const [x, y, w, h] = bbox;
    const ends = `x1="${x + w + 4}" y1="${y + h / 2}" x2="${columnX}" y2="${top + TAG_HEIGHT / 2}"`;
    return `<line ${ends} stroke="red" stroke-width="2" stroke-dasharray="6 4"/>`;
  });
  const tags = slots.map(({ box: { label }, top }) => {
    const place = `left:${columnX}px; top:${top}px; height:${TAG_HEIGHT}px; padding:0 8px`;
    return `<div style="position:absolute; ${place}; background:red; ${TEXT}">${escapeHtml(label)}</div>`;
  });
  const column = `<div style="position:absolute; left:${width}px; top:0; width:${LABEL_COLUMN}px; height:${height}px; background:#f3f4f6; border-left:2px solid #9ca3af"></div>`;
  const svg = `<svg width="${width + LABEL_COLUMN}" height="${height}" style="position:absolute; left:0; top:0">${lines.join("")}</svg>`;
  const img = `<img src="${shotUrl}" style="position:absolute; left:0; top:0; width:${width}px; height:${height}px">`;
  const canvas = `position:relative; width:${width + LABEL_COLUMN}px; height:${height}px; background:#fff`;
  return `<body style="margin:0"><div style="${canvas}">${img}${column}${frames.join("")}${svg}${tags.join("")}</div></body>`;
}

/** Writes `out`: the screenshot at `shotPng` with the boxes drawn and labelled (1580×720). */
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
    const shotUrl = `data:image/png;base64,${readFileSync(shotPng).toString("base64")}`;
    await page.setContent(annotateHtml(shotUrl, boxes));
    await page.screenshot({ path: out });
  } finally {
    await page.close();
  }
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
