// The verify job's recorder (§21): one Chromium for the whole job, each lane recorded with the
// observation protocol and its two videos rendered (§21.4), in a temporary folder that's removed
// when the job ends.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nextTakeDir, recordCriterion, renderVideos } from "@intenzo/core/browser";
import { chromium, type Browser } from "playwright";

import type { Recorder } from "./verify.ts";

export function browserRecorder(): Recorder {
  const root = mkdtempSync(join(tmpdir(), "intenzo-job-"));
  let browser: Promise<Browser> | undefined;
  return {
    async record({ side, origin, criterion, path, identity, bypass }) {
      const chrome = await (browser ??= chromium.launch());
      const outDir = nextTakeDir(root, criterion.id, side);
      const recording = await recordCriterion(chrome, {
        origin,
        side,
        criterion,
        path,
        outDir,
        ...(identity && { identity }),
        ...(bypass && { bypass }),
      });
      const { lane, alignment, rawVideo } = recording;
      // A video that can't be placed on the canonical clock can't be cited (§21.4).
      if (alignment.status !== "ok" || !rawVideo) return { lane, video: null };
      const videos = await renderVideos(
        {
          rawVideo,
          rawOffsetMs: alignment.offsetMs,
          markerShownAt: recording.markerShownAt,
          stepLog: lane.stepLog,
          laneStartMs: lane.laneStartMs,
          outDir,
        },
        { browser: chrome },
      );
      return {
        lane,
        video: {
          humanFile: videos.human.path,
          offsets: { human: videos.human.offsetMs, judge: videos.judge.offsetMs },
        },
      };
    },
    async close() {
      try {
        if (browser) await (await browser).close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
