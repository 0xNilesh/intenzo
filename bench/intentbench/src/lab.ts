// The live Lab for pnpm bench:record: one Chromium for the run, Wonder exploring as the worker
// does (§20.3), each take recorded with the observation protocol and its videos rendered (§21.4),
// and the diff from GitHub. A take keeps judge.mp4, human.mp4 and shot-annotated.png; the raw
// video and the trace go, since a trace holds the request headers, the bypass among them.
import { rmSync } from "node:fs";
import { join } from "node:path";

import { denyText, type IntenzoConfig } from "@intenzo/core";
import { recordCriterion, renderVideos } from "@intenzo/core/browser";
import { metaModelPort } from "@intenzo/core/models";
import { explore } from "@intenzo/core/navigator";
import { type Browser, chromium } from "playwright";

import { diffOf } from "./github.ts";
import type { Lab } from "./recorder.ts";

const DROPPED = ["raw.webm", "trace.zip", "shot.png", "boxes.json", "lane.json", ".video"];

export interface LiveLabOptions {
  modelApiKey: string;
  config: IntenzoConfig;
  /** The session hook: a fresh shopper per lane (§21.1). */
  identity: { hookPath: string; secret: string };
  bypass?: string;
}

export function liveLab(options: LiveLabOptions): Lab & { close(): Promise<void> } {
  const { config, identity, bypass } = options;
  const model = metaModelPort({ apiKey: options.modelApiKey });
  let browser: Promise<Browser> | undefined;
  const chrome = () => (browser ??= chromium.launch());
  return {
    async explore({ origin, criterion }) {
      return explore(await chrome(), {
        origin,
        criterion,
        model,
        denyText: denyText(config),
        allowedNavigationOrigins: config.guardrails.extra_navigation_origins,
        startPath: config.start.default,
        data: config.data,
        identity,
        ...(bypass && { bypass }),
      });
    },
    async record({ origin, side, criterion, path, outDir }) {
      const browser = await chrome();
      const recording = await recordCriterion(browser, {
        origin,
        side,
        criterion,
        path,
        outDir,
        identity,
        ...(bypass && { bypass }),
      });
      const { lane, alignment, rawVideo } = recording;
      // A video that can't be placed on the canonical clock can't be cited (§21.4).
      const videos =
        alignment.status === "ok" && rawVideo
          ? await renderVideos(
              {
                rawVideo,
                rawOffsetMs: alignment.offsetMs,
                markerShownAt: recording.markerShownAt,
                stepLog: lane.stepLog,
                laneStartMs: lane.laneStartMs,
                outDir,
              },
              { browser },
            )
          : null;
      for (const file of DROPPED) rmSync(join(outDir, file), { recursive: true, force: true });
      return {
        lane,
        judgeVideo: videos ? "judge.mp4" : null,
        humanVideo: videos ? "human.mp4" : null,
        annotatedShot: recording.annotatedShotPath ? "shot-annotated.png" : null,
        offsets: videos ? { human: videos.human.offsetMs, judge: videos.judge.offsetMs } : null,
      };
    },
    async diff(branch) {
      return diffOf(branch);
    },
    async close() {
      if (browser) await (await browser).close();
    },
  };
}
