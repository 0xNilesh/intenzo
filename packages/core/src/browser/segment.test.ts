import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ContentPart } from "../models/port.ts";
import { parseSamText, SamTimeoutError, type SamVideoRequest } from "../models/sam.ts";
import { scriptedPort } from "../models/scripted.ts";
import { masksOf, samSegmenter, type SegmentInput } from "./segment.ts";

// Recorded: SAM 3.1 on C4's evidence window, pointed at the discount slice (T5.2).
const RECORDED = readFileSync(
  new URL("../../../../fixtures/sam/c4-point.txt", import.meta.url),
  "utf8",
);
const C4 = {
  text: "The savings chart shows the discount slice",
  expected: "The savings chart in the order summary shows a slice for the discount",
};
const INPUT: SegmentInput = {
  clip: new Uint8Array([0, 0, 0, 24]),
  clipFrames: 50,
  stillFrame: 20,
  still: new Uint8Array([137, 80, 78, 71]),
  width: 1280,
  height: 720,
};

function fakeSam(answer: (request: SamVideoRequest) => Promise<string> | string) {
  const asked: SamVideoRequest[] = [];
  const sam = async (request: SamVideoRequest) => {
    asked.push(request);
    return { frames: parseSamText(await answer(request)) };
  };
  return { asked, sam };
}

describe("SAM for a visual criterion's evidence (§23, T5.2)", () => {
  it("has Spark 1.3 point at the criterion's subject in the still, then SAM track it from that frame", async () => {
    const port = scriptedPort([{ found: true, x: 944, y: 348 }]);
    const { asked, sam } = fakeSam(() => RECORDED);
    const result = await samSegmenter({ port, apiKey: "test-key", criterion: C4, sam })(INPUT);

    expect(port.requests[0]).toMatchObject({
      stage: "evidence",
      model: "muse-spark-1.3",
      promptVersion: "point.v1",
      reasoningEffort: "low",
    });
    const [text, image] = port.requests[0]!.messages[1]!.content as ContentPart[];
    expect(text).toMatchObject({ type: "text" });
    // The criterion is untrusted content (§13).
    expect((text as { text: string }).text).toContain('<untrusted source="criterion">');
    expect((text as { text: string }).text).toContain("shows a slice for the discount");
    expect(image).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw==" },
    });

    expect(asked).toEqual([
      {
        apiKey: "test-key",
        video: INPUT.clip,
        prompt: "<20f>1<|point;x=944;y=348;w=1280;h=720|>",
        timeoutMs: 20_000,
      },
    ]);
    expect(result.outcome).toBe("ok");
    expect(result.masks!.size).toBe(49);
    expect(result.masks!.get(20)).toMatchObject({
      box: { x1: 900, y1: 321, x2: 959, y2: 375 },
      rasterWidth: 60,
      rasterHeight: 55,
    });
    expect(result.masks!.get(20)!.path).toMatch(/^M/);
    // The 50-frame minimum; the scripted point call reports no usage.
    expect(result.costUsd).toBeCloseTo(0.01, 10);
  });

  it("doesn't call SAM when there's nothing to point at", async () => {
    const port = scriptedPort([{ found: false, x: 0, y: 0 }]);
    const { asked, sam } = fakeSam(() => RECORDED);
    const result = await samSegmenter({ port, apiKey: "k", criterion: C4, sam })(INPUT);
    expect(asked).toHaveLength(0);
    expect(result).toMatchObject({ masks: null, outcome: "not_found", costUsd: 0 });
  });

  it("falls back on a SAM timeout: no masks, the outcome says so, and the billed minimum counts", async () => {
    const port = scriptedPort([{ found: true, x: 944, y: 348 }]);
    const { sam } = fakeSam(() => {
      throw new SamTimeoutError(20_000);
    });
    const result = await samSegmenter({ port, apiKey: "k", criterion: C4, sam })(INPUT);
    expect(result).toMatchObject({ masks: null, outcome: "timeout" });
    expect(result.detail).toContain("(944, 348) on frame 20");
    expect(result.costUsd).toBeCloseTo(0.01, 10);
  });

  it("reports a failed point call or SAM error as failed, never throwing", async () => {
    const noReply = await samSegmenter({
      port: scriptedPort([]),
      apiKey: "k",
      criterion: C4,
      sam: fakeSam(() => RECORDED).sam,
    })(INPUT);
    expect(noReply).toMatchObject({ masks: null, outcome: "failed" });
    expect(noReply.detail).toMatch(/^point: /);

    const samError = await samSegmenter({
      port: scriptedPort([{ found: true, x: 1, y: 1 }]),
      apiKey: "k",
      criterion: C4,
      sam: fakeSam(() => {
        throw new Error("SAM: HTTP 500: busy");
      }).sam,
    })(INPUT);
    expect(samError).toMatchObject({ masks: null, outcome: "failed" });
  });

  it("calls an answer with no frames not found", async () => {
    const result = await samSegmenter({
      port: scriptedPort([{ found: true, x: 1, y: 1 }]),
      apiKey: "k",
      criterion: C4,
      sam: fakeSam(() => "").sam,
    })(INPUT);
    expect(result).toMatchObject({ masks: null, outcome: "not_found" });
  });

  it("decodes each frame's mask into an outline, and skips one that can't be decoded", () => {
    const frames = parseSamText(RECORDED);
    const broken = frames.map((f) =>
      f.frame === 21
        ? {
            ...f,
            objects: f.objects.map((o) => ({ ...o, mask: { ...o.mask!, payload: "!!!!!0" } })),
          }
        : f,
    );
    const masks = masksOf(broken);
    expect(masks.size).toBe(48);
    expect(masks.has(21)).toBe(false);
    expect(masks.has(20)).toBe(true);
  });
});
