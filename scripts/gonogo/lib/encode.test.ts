import { describe, expect, it } from "vitest";

import { annotateHtml, boxesAtShot, frameTimeMs, labelSlots, stampHtml } from "./encode.ts";
import type { Lane, Reading } from "./schema.ts";

const box = (label: string, y: number) => ({ label, bbox: [100, y, 200, 40] as const });

describe("judge clip frames", () => {
  it("stamp the lane time of frame n at 4 fps", () => {
    expect([0, 1, 8, 13].map(frameTimeMs)).toEqual([0, 250, 2000, 3250]);
  });

  it("put the time in a band below the page, never over it", () => {
    const html = stampHtml("data:image/png;base64,AA==", 1250);
    expect(html).toContain(">t=1250 ms</div>");
    expect(html).toContain("top:540px"); // the page is 960×540; the band starts under it
    expect(html).toContain("height:580px");
  });
});

describe("annotated screenshot", () => {
  it("places each label level with its box, pushing tags down so they never overlap", () => {
    const slots = labelSlots([box("order total", 400), box("discount line", 300), box("x", 305)]);
    expect(slots.map((s) => s.box.label)).toEqual(["discount line", "x", "order total"]);
    expect(slots[0]!.top).toBe(303); // centre 320 − 17
    expect(slots[1]!.top).toBe(slots[0]!.top + 40); // pushed below the first tag
    expect(slots[2]!.top).toBe(403);
  });

  it("draws labels in the column right of the screenshot and escapes them", () => {
    const html = annotateHtml("data:image/png;base64,AA==", [box('a<b & "c"', 300)]);
    expect(html).toContain(">a&lt;b &amp; &quot;c&quot;</div>");
    expect(html).toContain("left:1296px"); // 1280 px of page + 16
    expect(html).not.toContain('a<b & "c"');
  });

  it("boxes the elements as they were at Tt+1000", () => {
    const reading = (over: Partial<Reading>): Reading => ({
      i: 0,
      label: "order total",
      kind: "text",
      phase: "post",
      tMs: 10_000,
      value: "$45.00",
      bbox: [1, 2, 3, 4],
      ...over,
    });
    const lane: Lane = {
      clipId: "c",
      laneStartMs: 0,
      tTriggerMs: 10_000,
      stepLog: [],
      consoleErrorCount: 0,
      failedRequestCount: 0,
      readings: [
        reading({ phase: "pre", tMs: 9_000, bbox: [9, 9, 9, 9] }),
        reading({ tMs: 10_005, bbox: [8, 8, 8, 8] }), // Tt+0: too early
        reading({ tMs: 11_002 }), // Tt+1000: this one
        reading({ label: "error", kind: "absent", tMs: 11_003, value: null, bbox: null }),
        reading({ tMs: 13_001, bbox: [7, 7, 7, 7] }),
        reading({ label: "error", tMs: 13_002, value: "Oops", bbox: [5, 5, 5, 5] }), // too late
      ],
    };
    expect(boxesAtShot(lane)).toEqual([{ label: "order total", bbox: [1, 2, 3, 4] }]);
  });
});
