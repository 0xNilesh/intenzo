import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MAX_GIF_BYTES, renderEvidence } from "./evidence.ts";

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
  }, 60_000);
});
