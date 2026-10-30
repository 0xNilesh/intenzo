import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { StepLogEntry } from "../schema/index.ts";
import { alignVideo } from "./align.ts";
import { now, showSyncMarker } from "./clock.ts";
import { findFirstFrameMs, isMarkerGreen, probeVideo, type Rgb } from "./ffmpeg.ts";
import { openLane } from "./lane.ts";
import { html, startServer, type TestServer } from "./testing.ts";
import { CAPTION_MS, nextTakeDir, renderVideos, type VideoOutputs } from "./video.ts";

const isRed = ([r, g, b]: Rgb) => r > 200 && g < 80 && b < 80;

let browser: Browser;
let app: TestServer;
let dir: string;
let lane: Awaited<ReturnType<typeof recordLane>>;
let rawOffsetMs: number;
let take: string;
let videos: VideoOutputs;

/** Turns the whole page red; returns the canonical time it was painted. */
const paintRed = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        document.body.style.cssText = "margin:0;background:#FF0000";
        document.body.innerHTML = "";
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve(performance.timeOrigin + performance.now())),
        );
      }),
  );

/** A synthetic lane: the marker, two logged steps, then the page turns red at a known time. */
async function recordLane() {
  const laneStartMs = now();
  const recording = await openLane(browser, { origin: app.origin, videoDir: join(dir, "raw") });
  await recording.page.goto(app.origin);
  await recording.page.waitForTimeout(400);
  const markerShownAt = await showSyncMarker(recording.page);
  await recording.page.waitForTimeout(600);
  const fillAt = now();
  await recording.page.waitForTimeout(80);
  const clickAt = now();
  const stepLog: StepLogEntry[] = [
    {
      tMs: fillAt,
      step: { op: "fill", target: { by: "label", text: "Discount code" }, value: "SAVE10" },
      ok: true,
      trigger: true,
    },
    {
      tMs: clickAt,
      step: { op: "click", target: { by: "role", role: "button", name: "Apply" } },
      ok: true,
      trigger: true,
    },
  ];
  await recording.page.waitForTimeout(CAPTION_MS + 600); // the captions come and go on white
  const redAt = await paintRed(recording.page);
  await recording.page.waitForTimeout(800);
  const { videoPath } = await recording.close();
  return { video: videoPath!, laneStartMs, markerShownAt, stepLog, clickAt, redAt };
}

/** One RGB frame of `video` at file time `ms`, cropped to w×h at (x, y). */
function frameAt(video: string, ms: number, [x, y, w, h]: [number, number, number, number]) {
  // prettier-ignore
  return execFileSync("ffmpeg", ["-v", "error", "-ss", String(ms / 1000), "-i", video, "-frames:v", "1", "-vf", `crop=${w}:${h}:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 16 * 1024 * 1024 });
}

const mean = (frame: Buffer) => frame.reduce((sum, v) => sum + v, 0) / frame.length;
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

beforeAll(async () => {
  browser = await chromium.launch();
  app = await startServer("127.0.0.1", (_req, res) => html(res, "<h1 style='margin:0'>Cart</h1>"));
  dir = mkdtempSync(join(tmpdir(), "intenzo-video-"));
  lane = await recordLane();
  const alignment = alignVideo({ video: lane.video, markerShownAt: lane.markerShownAt });
  if (alignment.status !== "ok") throw new Error(alignment.reason);
  rawOffsetMs = alignment.offsetMs;
  take = nextTakeDir(join(dir, "runs", "run-1"), "C2", "pr");
  videos = await renderVideos(
    {
      rawVideo: lane.video,
      rawOffsetMs,
      markerShownAt: lane.markerShownAt,
      stepLog: lane.stepLog,
      laneStartMs: lane.laneStartMs,
      outDir: take,
    },
    { browser },
  );
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("renderVideos", () => {
  it("writes both files into the take folder", () => {
    expect(take).toBe(join(dir, "runs", "run-1", "C2", "pr", "take-1"));
    expect(readdirSync(take).sort()).toEqual(["human.mp4", "judge.mp4"]);
    expect(videos.human.path).toBe(join(take, "human.mp4"));
    expect(videos.judge.path).toBe(join(take, "judge.mp4"));
  });

  it("encodes the human video as 1280×720 H.264 at the raw frame rate, from the marker's end", () => {
    const raw = probeVideo(lane.video);
    const human = probeVideo(videos.human.path);
    expect(human).toMatchObject({ codec: "h264", width: 1280, height: 720, pixFmt: "yuv420p" });
    expect(human.fps).toBe(raw.fps);
    const cutMs = rawOffsetMs - videos.human.offsetMs; // where the human video starts, in raw ms
    expect(cutMs).toBeGreaterThan(lane.markerShownAt + rawOffsetMs); // after the marker started…
    expect(Math.abs(human.durationMs - (raw.durationMs - cutMs))).toBeLessThanOrEqual(80);
    // faststart: the index comes before the media, so a browser can play it while it loads
    const bytes = readFileSync(videos.human.path);
    expect(bytes.indexOf("moov")).toBeLessThan(bytes.indexOf("mdat"));
  });

  it("encodes the judge video as 960×540 + a 40 px band, H.264 at 4 fps", () => {
    const judge = probeVideo(videos.judge.path);
    expect(judge).toMatchObject({ codec: "h264", width: 960, height: 580, pixFmt: "yuv420p" });
    expect(judge.fps).toBe(4);
    const startRawMs = rawOffsetMs - videos.judge.offsetMs;
    const raw = probeVideo(lane.video);
    expect(Math.abs(judge.durationMs - (raw.durationMs - startRawMs))).toBeLessThanOrEqual(250);
  });

  it("keeps both offsets exact: the red frame lands where canonical time + offsetMs says", () => {
    const rawRed = findFirstFrameMs(lane.video, isRed)!;
    const humanRed = findFirstFrameMs(videos.human.path, isRed);
    // The band is 40 of the judge frame's 580 rows, so a red page is ~93 % of its pixels.
    const judgeRed = findFirstFrameMs(videos.judge.path, isRed, 0.85);
    expect(humanRed).not.toBeNull();
    expect(judgeRed).not.toBeNull();
    expect(Math.abs(humanRed! - (lane.redAt + videos.human.offsetMs))).toBeLessThanOrEqual(50);
    // One 4 fps frame (250 ms) plus the marker alignment's own error (±50 ms, as above).
    expect(Math.abs(judgeRed! - (lane.redAt + videos.judge.offsetMs))).toBeLessThanOrEqual(300);
    // And exactly: the human video is the raw one shifted by the cut, frame for frame…
    const cutMs = rawOffsetMs - videos.human.offsetMs;
    expect(Math.abs(humanRed! - (rawRed - cutMs))).toBeLessThanOrEqual(1);
    // …and each judge frame shows the last raw frame at or before its canonical time.
    const judgeStartRawMs = rawOffsetMs - videos.judge.offsetMs;
    const slot = Math.ceil((rawRed - judgeStartRawMs) / 250 - 1e-6) * 250;
    expect(Math.abs(judgeRed! - slot)).toBeLessThanOrEqual(1);
  });

  it("cuts the sync marker from both videos", () => {
    // …and it ends after the marker has gone: no frame of either video shows any of it.
    expect(findFirstFrameMs(videos.human.path, isMarkerGreen, 0.05)).toBeNull();
    expect(findFirstFrameMs(videos.judge.path, isMarkerGreen, 0.05)).toBeNull();
  });

  it("burns the click's caption into the human video's bottom-left corner while it's on", () => {
    const clickMs = lane.clickAt + videos.human.offsetMs;
    const corner: [number, number, number, number] = [24, 720 - 24 - 30, 120, 30];
    expect(mean(frameAt(videos.human.path, clickMs + 300, corner))).toBeLessThan(120); // dark tag
    expect(mean(frameAt(videos.human.path, clickMs + CAPTION_MS + 200, corner))).toBeGreaterThan(
      240,
    ); // gone: the white page
  });

  it("puts the timestamp in the band under the page, not over it", () => {
    const band = frameAt(videos.judge.path, 500, [0, 540, 960, 40]);
    const whiteShare = band.filter((v) => v > 200).length / band.length;
    expect(whiteShare).toBeGreaterThan(0.01); // text
    expect(whiteShare).toBeLessThan(0.3); // on black
    expect(mean(frameAt(videos.judge.path, 500, [0, 0, 960, 540]))).toBeGreaterThan(200); // the white page, untouched
  });

  it("starts a second take in take-2 and leaves take-1 alone", () => {
    const before = [sha(videos.human.path), sha(videos.judge.path)];
    const second = nextTakeDir(join(dir, "runs", "run-1"), "C2", "pr");
    expect(second).toBe(join(dir, "runs", "run-1", "C2", "pr", "take-2"));
    expect(readdirSync(second)).toEqual([]);
    expect([sha(videos.human.path), sha(videos.judge.path)]).toEqual(before);
  });
});
