import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { stillsOf, VIDEO_FPS } from "./frames.ts";

// The browser layer, which has ffmpeg (CI installs it for this layer): a 4 fps clip whose frame
// number is its colour, cut into stills the way arm C cuts the judge videos.
let dir: string;
let video: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "intentbench-frames-"));
  video = join(dir, "judge.mp4");
  // 19 frames at 4 fps, like a 4.75 s judge video: frame n is grey level 10·n.
  const r = spawnSync(
    "ffmpeg",
    [
      ...["-v", "error", "-f", "lavfi", "-i", `color=c=black:s=96x58:r=${VIDEO_FPS}:d=4.75`],
      ...["-vf", "geq=lum=10*N:cb=128:cr=128", "-pix_fmt", "yuv420p", video],
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The mean grey level of each frame of a video or image, through ffmpeg. */
function greys(file: string): number[] {
  const r = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-vf", "scale=1:1,format=gray", "-f", "rawvideo", "-"],
    { maxBuffer: 1024 },
  );
  return [...r.stdout];
}

describe("stillsOf (arm C)", () => {
  it("keeps every other frame of the 4 fps video: 2 stills a second, in order", () => {
    const frames = greys(video);
    expect(frames).toHaveLength(19);
    const stills = stillsOf(video, join(dir, "stills"));
    expect(stills).toHaveLength(10);
    // Frames 0, 2, 4, …, 18, each still within a few levels of its frame (JPEG).
    stills.forEach((s, k) => expect(Math.abs(greys(s)[0]! - frames[2 * k]!)).toBeLessThan(4));
  });

  it("cuts once, and reuses the stills after", () => {
    const out = join(dir, "again");
    const first = stillsOf(video, out);
    const made = statSync(first[0]!).mtimeMs;
    expect(stillsOf(video, out)).toEqual(first);
    expect(statSync(first[0]!).mtimeMs).toBe(made);
  });
});
