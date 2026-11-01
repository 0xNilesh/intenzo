// The verify job's recorder (§21): one Chromium for the whole job, each lane recorded with the
// observation protocol and its two videos rendered (§21.4), in a temporary folder that's removed
// when the job ends. Given the Meta key, it also explores (§20.3) with the same Chromium.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { denyText } from "@intenzo/core";
import {
  acquireIdentity,
  nextTakeDir,
  openLane,
  recordCriterion,
  renderEvidence,
  renderVideos,
  routeSnapshot,
  Settler,
} from "@intenzo/core/browser";
import { metaModelPort } from "@intenzo/core/models";
import { explore } from "@intenzo/core/navigator";
import { chromium, type Browser } from "playwright";

import type { Recorder } from "./verify.ts";

export interface RecorderOptions {
  /** The Meta Model API key; without it the recorder can't explore and jobs use fixture paths. */
  modelApiKey?: string;
}

export function browserRecorder(options: RecorderOptions = {}): Recorder {
  const root = mkdtempSync(join(tmpdir(), "intenzo-job-"));
  let browser: Promise<Browser> | undefined;
  const model = options.modelApiKey ? metaModelPort({ apiKey: options.modelApiKey }) : null;
  return {
    ...(model && {
      async explore({ origin, criterion, config, identity, bypass }) {
        const chrome = await (browser ??= chromium.launch());
        return explore(chrome, {
          origin,
          criterion,
          model,
          denyText: denyText(config),
          allowedNavigationOrigins: config.guardrails.extra_navigation_origins,
          startPath: config.start.default,
          data: config.data,
          ...(identity && { identity }),
          ...(bypass && { bypass }),
        });
      },
    }),
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
        // For the evidence GIF (§23): where the watched elements were, frame by frame.
        boxTrack: recording.boxTrack,
        // For the judges (§22.2): kept until the job ends, in the recorder's folder.
        judge: {
          video: videos.judge.path,
          ...(recording.annotatedShotPath && { annotatedShot: recording.annotatedShotPath }),
        },
      };
    },
    async snapshot({ origin, route, targets, identity, bypass }) {
      const chrome = await (browser ??= chromium.launch());
      const lane = await openLane(chrome, { origin, ...(bypass && { bypass }) });
      try {
        const settler = await Settler.install(lane.context, origin);
        // §24: a fresh identity per side, masked out of the snapshot by name.
        const users = identity ? [await acquireIdentity(lane, identity)] : [];
        await lane.page.goto(new URL(route, origin).href, { waitUntil: "load" });
        await settler.settle(lane.page);
        return await routeSnapshot(lane.page, { users, targets });
      } finally {
        await lane.close();
      }
    },
    async evidence(input) {
      const chrome = await (browser ??= chromium.launch());
      // Its own folder per render; the take folders are named by criterion (§28).
      return renderEvidence(chrome, { ...input, outDir: mkdtempSync(join(root, "evidence-")) });
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
