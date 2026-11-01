// Arm C's stills (§31, T6.3): a judge video at 2 frames per second. The judge video runs at 4 fps
// with the canonical time burned into a band under each frame (§21.4), so every other frame is
// kept as it is: nothing is resampled, and each still shows the time it was taken.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The judge video's frame rate (§21.4), and the stills' (§31). */
export const VIDEO_FPS = 4;
export const STILLS_FPS = 2;

/** The stills of `video`, cut into `dir` the first time and reused after; in time order. */
export function stillsOf(video: string, dir: string): string[] {
  const done = join(dir, ".done");
  if (!existsSync(done)) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const every = VIDEO_FPS / STILLS_FPS;
    const r = spawnSync(
      "ffmpeg",
      [
        ...["-v", "error", "-i", video],
        ...["-vf", `select=not(mod(n\\,${every}))`, "-fps_mode", "passthrough"],
        ...["-q:v", "3", join(dir, "%02d.jpg")],
      ],
      { encoding: "utf8" },
    );
    if (r.status !== 0) {
      throw new Error(`ffmpeg couldn't cut stills from ${video}: ${(r.stderr ?? "").trim()}`);
    }
    writeFileSync(done, "");
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => join(dir, f));
}
