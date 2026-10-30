import { describe, expect, it } from "vitest";

import { isMarkerGreen, pixelShare } from "./ffmpeg.ts";

const frame = (...pixels: [number, number, number][]) => Buffer.from(pixels.flat());

describe("isMarkerGreen", () => {
  it("accepts the marker colour after compression drift", () => {
    expect(isMarkerGreen([0, 255, 0])).toBe(true);
    expect(isMarkerGreen([60, 214, 70])).toBe(true);
  });

  it("rejects page colours that merely contain green", () => {
    expect(isMarkerGreen([255, 255, 255])).toBe(false); // white
    expect(isMarkerGreen([120, 220, 120])).toBe(false); // light green UI
    expect(isMarkerGreen([0, 150, 0])).toBe(false); // dark green
  });
});

describe("pixelShare", () => {
  it("is the fraction of pixels passing the test", () => {
    const f = frame([0, 255, 0], [0, 255, 0], [0, 255, 0], [255, 255, 255]);
    expect(pixelShare(f, isMarkerGreen)).toBe(0.75);
  });
});
