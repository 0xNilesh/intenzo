import { describe, expect, it } from "vitest";

import { iou, parseSamLine, parseSamOutput } from "./sam-format.ts";

const BOX = "x1=620;y1=300;x2=819;y2=419;w=960;h=540";

describe("parseSamLine", () => {
  it("reads the frame, object ids, boxes and mask headers", () => {
    const line = `<12f>0<|box;${BOX}|><|mask;x=0;y=0;data=120,200,~a;b=c,d|>,3<|box;x1=1;y1=2;x2=3;y2=4;w=960;h=540|><|mask;x=0;y=0;data=3,3,!xyz|>`;
    expect(parseSamLine(line)).toEqual({
      frame: 12,
      objects: [
        {
          id: 0,
          box: { x1: 620, y1: 300, x2: 819, y2: 419, w: 960, h: 540 },
          mask: { h: 120, w: 200, encoding: "lossless", payloadChars: 7 },
        },
        {
          id: 3,
          box: { x1: 1, y1: 2, x2: 3, y2: 4, w: 960, h: 540 },
          mask: { h: 3, w: 3, encoding: "one_bit", payloadChars: 3 },
        },
      ],
    });
  });

  it("reads confidence on boxes and masks when present", () => {
    const frame = parseSamLine(`<0f>1<|box;${BOX};c=0.97|><|mask;x=0;y=0;c=0.91;data=2,2,~ab|>`);
    expect(frame?.objects[0]?.box.c).toBe(0.97);
    expect(frame?.objects[0]?.mask?.c).toBe(0.91);
  });

  it("accepts a box without a mask", () => {
    expect(parseSamLine(`<0f>1<|box;${BOX}|>`)?.objects[0]?.mask).toBeNull();
  });

  it("returns null for lines without a frame marker", () => {
    expect(parseSamLine("")).toBeNull();
    expect(parseSamLine("no frames here")).toBeNull();
  });
});

describe("parseSamOutput", () => {
  it("parses one frame per line and keeps explicit (possibly skipped) frame numbers", () => {
    const frames = parseSamOutput(`<0f>1<|box;${BOX}|>\n<2f>1<|box;${BOX}|>\n`);
    expect(frames.map((f) => f.frame)).toEqual([0, 2]);
  });
});

describe("iou", () => {
  const a = { x1: 0, y1: 0, x2: 9, y2: 9 };

  it("is 1 for identical boxes", () => {
    expect(iou(a, a)).toBe(1);
  });

  it("is 0 for disjoint boxes", () => {
    expect(iou(a, { x1: 20, y1: 20, x2: 29, y2: 29 })).toBe(0);
  });

  it("uses inclusive pixel coordinates", () => {
    // 10x10 boxes overlapping in a 5x10 strip: 50 / (100 + 100 - 50)
    expect(iou(a, { x1: 5, y1: 0, x2: 14, y2: 9 })).toBeCloseTo(1 / 3);
  });
});
