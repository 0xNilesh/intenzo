import { describe, expect, it } from "vitest";

import type { BoxSample } from "./boxes.ts";
import { boxAt, captionOf, gifAttempts, outlinedLabel, samPadding } from "./evidence.ts";

describe("the evidence GIF's rules (§23)", () => {
  it("lowers the frame rate first, then the width, to fit under 2 MB", () => {
    expect(gifAttempts()).toEqual([
      { fps: 8, width: 640 },
      { fps: 6, width: 640 },
      { fps: 4, width: 640 },
      { fps: 4, width: 480 },
      { fps: 4, width: 360 },
    ]);
  });

  const track: BoxSample[] = [
    { tMs: 1000, label: "order total", box: [880, 410, 96, 24] },
    { tMs: 1016, label: "order summary", box: [780, 140, 340, 560] },
    { tMs: 1100, label: "order total", box: [880, 412, 96, 24] },
    { tMs: 1200, label: "order total", box: null },
    { tMs: 2000, label: "order total", box: [880, 414, 96, 24] },
  ];

  it("outlines the label's last recorded box: the track only records changes", () => {
    expect(boxAt(track, "order total", 1040)).toEqual([880, 410, 96, 24]);
    expect(boxAt(track, "order total", 1120)).toEqual([880, 412, 96, 24]);
    // Gone at 1200 (a null sample), back at 2000, and held until the next change.
    expect(boxAt(track, "order total", 1600)).toBeNull();
    expect(boxAt(track, "order total", 2000)).toEqual([880, 414, 96, 24]);
    expect(boxAt(track, "order total", 9000)).toEqual([880, 414, 96, 24]);
    // A box recorded up to 50 ms after the frame counts for it (frame timing jitter), no more.
    expect(boxAt(track, "order total", 960)).toEqual([880, 410, 96, 24]);
    expect(boxAt(track, "order total", 940)).toBeNull();
    expect(boxAt(track, "order summary", 1000)).toEqual([780, 140, 340, 560]);
    expect(boxAt(track, "discount line", 1000)).toBeNull();
  });

  it("outlines a label whose box shows in the window, even one recorded before it", () => {
    // Recorded at 1000, unchanged since: shown all through a window that starts later.
    expect(outlinedLabel(track, { startMs: 1050, endMs: 1090 })).toBe("order total");
    // Gone from 1200 until 2000: shown again inside the window.
    expect(outlinedLabel(track, { startMs: 1300, endMs: 2500 })).toBe("order total");
    // Gone for the whole window.
    const gone = track.filter((b) => b.label === "order total" && b.tMs < 2000);
    expect(outlinedLabel(gone, { startMs: 1300, endMs: 1900 })).toBeNull();
    expect(outlinedLabel([], { startMs: 0, endMs: 1000 })).toBeNull();
  });

  it("holds the last frame so SAM gets its 50-frame minimum, which it bills anyway", () => {
    expect(samPadding(40)).toBe(10);
    expect(samPadding(50)).toBe(0);
    expect(samPadding(73)).toBe(0);
  });

  it("captions the verdict on one short line", () => {
    expect(captionOf("C2", "fail", "The total stayed $50.00\nafter Apply.")).toBe(
      "C2 ❌ The total stayed $50.00 after Apply.",
    );
    expect(captionOf("C1", "pass", "x".repeat(200))).toHaveLength(3 + 2 + 90);
  });
});
