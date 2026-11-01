import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseSamText } from "../models/sam.ts";
import { MAX_GIF_BYTES, renderEvidence } from "./evidence.ts";
import { masksOf, type SegmentInput, type SegmentResult } from "./segment.ts";

/** The RGB of one pixel of a PNG, read by ffmpeg. */
function pixel(png: string, x: number, y: number): [number, number, number] {
  const rgb = execFileSync("ffmpeg", [
    "-loglevel",
    "error",
    "-i",
    png,
    "-vf",
    `crop=1:1:${x}:${y}`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);
  return [rgb[0]!, rgb[1]!, rgb[2]!];
}

/** Pixels of the outline's red (#FF3B30) in a rectangle of a PNG. */
function redPixels(png: string, x: number, y: number, w: number, h: number): number {
  const rgb = execFileSync("ffmpeg", [
    "-loglevel",
    "error",
    "-i",
    png,
    "-vf",
    `crop=${w}:${h}:${x}:${y}`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);
  let red = 0;
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    if (rgb[i]! > 200 && rgb[i + 1]! < 120 && rgb[i + 2]! < 120) red++;
  }
  return red;
}

/** White, give or take H.264's rounding. */
const white = (rgb: number[]) => rgb.every((v) => v >= 250);

/** Frames in an MP4, counted by ffprobe. */
function framesIn(mp4: string): number {
  return Number(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "csv=p=0",
      mp4,
    ])
      .toString()
      .trim(),
  );
}

// A real render: a 6 s synthetic 1280×720 video stands in for human.mp4, and the box track puts
// the "order total" box on it from 2 s to 5 s.
describe("renderEvidence (§23)", () => {
  let browser: Browser;
  let dir: string;
  beforeAll(async () => {
    browser = await chromium.launch();
    dir = mkdtempSync(join(tmpdir(), "intenzo-evidence-test-"));
    execFileSync("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1280x720:rate=25:duration=6",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      join(dir, "human.mp4"),
    ]);
    // A white page, so SAM's red mask shows in the pixels.
    execFileSync("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=white:size=1280x720:rate=25:duration=6",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      join(dir, "white.mp4"),
    ]);
  });
  afterAll(async () => {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("makes a GIF under 2 MB over the window, outlined where the box track saw the element, and a still", async () => {
    const T0 = 1_900_000_000_000;
    // As the poller records it: only the changes. The total appears at 2 s and is gone at 4 s.
    const boxTrack = [
      {
        tMs: T0 + 2000,
        label: "order total",
        box: [880, 410, 96, 24] as [number, number, number, number],
      },
      { tMs: T0 + 4000, label: "order total", box: null },
    ];
    const out = await renderEvidence(browser, {
      humanVideo: join(dir, "human.mp4"),
      humanOffsetMs: -T0, // the video starts at T0
      window: { startMs: T0 + 1000, endMs: T0 + 5000 },
      tTriggerMs: T0 + 2000,
      boxTrack,
      label: "order total",
      caption: "C2 ❌ The total stayed $50.00 after Apply",
      outDir: join(dir, "out"),
    });
    expect(existsSync(out.gif) && existsSync(out.still)).toBe(true);
    expect(out.bytes).toBeLessThanOrEqual(MAX_GIF_BYTES);
    expect(statSync(out.gif).size).toBe(out.bytes);
    expect(out.frames).toBe(40); // 4 s at 10 fps
    expect(out.outlined).toBe(20); // 2 s to 4 s of the 1 s to 5 s window, at 10 fps
    expect({ fps: out.fps, width: out.width }).toEqual({ fps: 8, width: 640 });
    expect(out.segmentation).toBeUndefined();
  }, 60_000);

  // T5.2: C4's recorded SAM masks (the discount slice, frames 1–49 of the window), on a white page.
  const recorded = masksOf(
    parseSamText(
      readFileSync(new URL("../../../../fixtures/sam/c4-point.txt", import.meta.url), "utf8"),
    ),
  );
  const T0 = 1_900_000_000_000;
  const visual = (segment: (input: SegmentInput) => Promise<SegmentResult>, out: string) =>
    renderEvidence(browser, {
      humanVideo: join(dir, "white.mp4"),
      humanOffsetMs: -T0,
      window: { startMs: T0 + 1000, endMs: T0 + 5000 },
      tTriggerMs: T0 + 2000,
      boxTrack: [{ tMs: T0, label: "savings chart", box: [838, 310, 240, 240] }],
      label: "savings chart",
      caption: "C4 ✅ The chart shows the discount slice",
      outDir: join(dir, out),
      segment,
    });

  it("draws SAM's mask instead of the box, from a 50-frame clip and the still's frame", async () => {
    let seen: SegmentInput | undefined;
    const out = await visual(async (input) => {
      seen = input;
      writeFileSync(join(dir, "clip.mp4"), input.clip);
      return { masks: recorded, outcome: "ok", costUsd: 0.01, detail: "(944, 348) on frame 20" };
    }, "mask");
    expect(seen).toMatchObject({ clipFrames: 50, stillFrame: 20, width: 1280, height: 720 });
    expect(framesIn(join(dir, "clip.mp4"))).toBe(50); // 40 frames, the last held for 10 more
    expect(seen!.still.subarray(1, 4).toString()).toBe("PNG");
    // Frames 1–39 of the window have a mask; frame 0 (no slice yet) has none, and no box either.
    expect(out.outlined).toBe(39);
    expect(out.segmentation).toEqual({
      outcome: "ok",
      costUsd: 0.01,
      detail: "(944, 348) on frame 20",
      masked: 39,
    });
    // The still (48 px of caption above the page): the slice's outline in red inside its box
    // (900–959 × 321–375), the slice itself left as it was, and nothing beside it.
    expect(redPixels(out.still, 895, 316 + 48, 70, 65)).toBeGreaterThan(150);
    expect(white(pixel(out.still, 944, 348 + 48))).toBe(true);
    expect(redPixels(out.still, 600, 316 + 48, 70, 65)).toBe(0);
  }, 60_000);

  it("falls back to the element's box when SAM has no masks (§23: a timeout)", async () => {
    const out = await visual(
      async () => ({ masks: null, outcome: "timeout", costUsd: 0.01, detail: "SAM didn't answer" }),
      "fallback",
    );
    expect(out.outlined).toBe(40); // the chart's box, on every frame
    expect(out.segmentation).toMatchObject({ outcome: "timeout", masked: 0 });
    // The box outline, #FF3B30 4 px outside the chart's box; nothing on the slice.
    const [r, g, b] = pixel(out.still, 838 - 4, 400 + 48);
    expect(r).toBeGreaterThan(200);
    expect(Math.max(g, b)).toBeLessThan(120);
    expect(white(pixel(out.still, 944, 348 + 48))).toBe(true);
  }, 60_000);
});
