import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { alignVideo } from "./align.ts";
import { showSyncMarker } from "./clock.ts";
import { findFirstFrameMs, type Rgb } from "./ffmpeg.ts";
import { openLane } from "./lane.ts";
import { html, startServer, type TestServer } from "./testing.ts";

const isRed = ([r, g, b]: Rgb) => r > 200 && g < 80 && b < 80;

let browser: Browser;
let app: TestServer;
let dir: string;

beforeAll(async () => {
  browser = await chromium.launch();
  app = await startServer("127.0.0.1", (_req, res) => html(res, "<h1 style='margin:0'>Cart</h1>"));
  dir = mkdtempSync(join(tmpdir(), "intenzo-align-"));
});

afterAll(async () => {
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

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

/** Records a lane that (optionally) shows the marker, then turns red at a known canonical time. */
async function record(name: string, withMarker: boolean) {
  const lane = await openLane(browser, {
    origin: app.origin,
    videoDir: join(dir, name),
    tracePath: join(dir, `${name}.zip`),
  });
  await lane.page.goto(app.origin);
  await lane.page.waitForTimeout(400);
  const markerShownAt = withMarker ? await showSyncMarker(lane.page) : undefined;
  await lane.page.waitForTimeout(500);
  const redAt = await paintRed(lane.page);
  await lane.page.waitForTimeout(500);
  const { videoPath, tracePath } = await lane.close();
  return { video: videoPath!, trace: tracePath!, markerShownAt, redAt };
}

describe("alignVideo", () => {
  it("aligns with the marker: a known event lands within ±50 ms of its predicted video time", async () => {
    const run = await record("marker", true);
    const alignment = alignVideo(run);
    expect(alignment).toMatchObject({ status: "ok", method: "marker" });
    if (alignment.status !== "ok") return;
    const redVideoMs = findFirstFrameMs(run.video, isRed);
    expect(redVideoMs).not.toBeNull();
    expect(Math.abs(run.redAt + alignment.offsetMs - redVideoMs!)).toBeLessThanOrEqual(50);
  });

  it("falls back to the trace when the video has no marker, still within about one frame", async () => {
    const run = await record("no-marker", false);
    const alignment = alignVideo({ ...run, markerShownAt: run.redAt - 500 }); // a marker that never painted
    expect(alignment).toMatchObject({ status: "ok", method: "trace" });
    if (alignment.status !== "ok") return;
    const redVideoMs = findFirstFrameMs(run.video, isRed);
    expect(Math.abs(run.redAt + alignment.offsetMs - redVideoMs!)).toBeLessThanOrEqual(80);
  });

  it("is an infra_error when there's neither a marker nor a trace", async () => {
    const run = await record("nothing", false);
    expect(alignVideo({ video: run.video, markerShownAt: run.redAt })).toEqual({
      status: "infra_error",
      reason: "couldn't align the video: no marker frame found and no usable trace",
    });
  });
});
