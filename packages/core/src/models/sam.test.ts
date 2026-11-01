import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseSamText, pointPrompt, samCostUsd } from "./sam.ts";

// Recorded: SAM 3.1 on C4's evidence window (almost-right preview, 50 frames at 10 fps), pointed
// at the discount slice, (944, 348) on frame 20 (DECISIONS 2026-11-01, T5.2).
const RECORDED = readFileSync(
  new URL("../../../../fixtures/sam/c4-point.txt", import.meta.url),
  "utf8",
);

describe("SAM 3.1's wire format (dev.meta.ai/docs/sam/segmenting, /reading-segmentation)", () => {
  it("names one object with a point on one frame, clamped to the video", () => {
    expect(pointPrompt({ frame: 20, x: 944, y: 348, width: 1280, height: 720 })).toBe(
      "<20f>1<|point;x=944;y=348;w=1280;h=720|>",
    );
    expect(pointPrompt({ frame: 0, x: 1400.6, y: -3, width: 1280, height: 720 })).toBe(
      "<0f>1<|point;x=1279;y=0;w=1280;h=720|>",
    );
  });

  it("bills at least 50 frames a request, at $0.20 per 1,000", () => {
    expect(samCostUsd(40)).toBeCloseTo(0.01, 10);
    expect(samCostUsd(50)).toBeCloseTo(0.01, 10);
    expect(samCostUsd(120)).toBeCloseTo(0.024, 10);
  });

  it("reads each frame's box, confidence and mask, keeping the payload for the decoder", () => {
    const frames = parseSamText(RECORDED);
    expect(frames).toHaveLength(49);
    expect(frames.map((f) => f.frame)).not.toContain(0); // no slice yet on the first frame
    const f20 = frames.find((f) => f.frame === 20)!;
    expect(f20.objects).toHaveLength(1);
    const [object] = f20.objects;
    expect(object!.id).toBe(1);
    expect(object!.box).toEqual({ x1: 900, y1: 321, x2: 959, y2: 375 });
    expect(object!.confidence).toBeCloseTo(0.8867, 3);
    // data=H,W,…: 55 rows of 60 columns, one_bit as box and point prompts always are.
    expect(object!.mask).toMatchObject({ encoding: "one_bit", height: 55, width: 60 });
    expect(object!.mask!.payload.startsWith("!")).toBe(true);
    expect(object!.mask!.payload).not.toContain("|");
  });

  it("skips lines that aren't frames, and records without a mask keep a null one", () => {
    const frames = parseSamText(
      "noise\n<3f>2<|box;x1=1;y1=2;x2=3;y2=4;w=10;h=10|>\n\n<4f>2<|box;x1=1;y1=2;x2=3;y2=4;w=10;h=10;c=0.5|><|mask;x=0;y=0;data=bad|>",
    );
    expect(frames).toEqual([
      {
        frame: 3,
        objects: [{ id: 2, box: { x1: 1, y1: 2, x2: 3, y2: 4 }, confidence: null, mask: null }],
      },
      {
        frame: 4,
        objects: [{ id: 2, box: { x1: 1, y1: 2, x2: 3, y2: 4 }, confidence: 0.5, mask: null }],
      },
    ]);
  });
});
