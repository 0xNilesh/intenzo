import { renameSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import type { Browser, Locator, Page } from "playwright";

import type { Clip } from "../clips.ts";
import { diffLines, snapshotLines } from "./regions.ts";
import type { Lane, Reading, Step, StepLogEntry, Target, WatchTarget } from "./schema.ts";

/** POST readings are taken at these offsets from Tt (§21.3 step 8), plus the criterion's timingMs. */
export const POST_OFFSETS_MS = [0, 1000, 3000];
/** The plain screenshot that gets annotated offline (§21.3 step 9). */
export const SHOT_OFFSET_MS = 1000;
export const VIEWPORT = { width: 1280, height: 720 };
export const LIVE_REGIONS = "live regions";

// Top-level live regions only: a toast inside an aria-live container is read once, through it.
const LIVE = "[role=alert], [role=status], [role=dialog], [role=alertdialog], [aria-live]";
const TOP_LEVEL_LIVE = `:is(${LIVE}):not(:is(${LIVE}) *)`;
const SETTLE_MS = 300;
const TAIL_MS = 500;

type Phase = Reading["phase"];
type AriaRole = Parameters<Page["getByRole"]>[0];

export interface RecordOptions {
  /** Directory for raw.webm, the 1280×720 recording. No video when omitted. */
  videoDir?: string;
  /** Where to write the plain Tt+1000 screenshot. */
  shotPath?: string;
}

/**
 * Records one clip on the fixture shop with a cut-down §21.3 observation protocol: open the cart,
 * run the setup steps, read PRE, run the trigger (Tt = when the last trigger action resolves), read
 * POST at Tt+0/+1000/+3000 (+ timingMs), take the Tt+1000 screenshot, and reload for after_reload
 * readings when the criterion needs persistence. Settling is a fixed 300 ms wait, which is enough
 * for this static page; T1.6 builds the real settle().
 */
export async function recordClip(
  browser: Browser,
  origin: string,
  clip: Clip,
  options: RecordOptions = {},
): Promise<Lane> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: "en-US",
    timezoneId: "UTC",
    ...(options.videoDir && { recordVideo: { dir: options.videoDir, size: VIEWPORT } }),
  });
  context.setDefaultTimeout(5000);
  const page = await context.newPage();
  const laneStartMs = Date.now();
  const consoleErrors: number[] = [];
  const failedRequests: number[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(Date.now());
  });
  page.on("requestfailed", () => failedRequests.push(Date.now()));

  const stepLog: StepLogEntry[] = [];
  const readings: Reading[] = [];
  // Every step is stamped when its action resolves, so the trigger step's time is Tt.
  const run = async (step: Step, trigger = false): Promise<void> => {
    try {
      await act(page, step, origin, clip);
      stepLog.push({ tMs: Date.now(), step, ok: true, trigger });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      stepLog.push({ tMs: Date.now(), step, ok: false, trigger, error });
      throw new Error(`clip ${clip.id}: ${step.op} failed: ${error}`, { cause: err });
    }
  };
  const read = async (phase: Phase, liveBefore: readonly string[]): Promise<void> => {
    for (const target of clip.watch)
      readings.push(await readElement(page, target, phase, readings.length));
    const tMs = Date.now();
    const lines = await liveLines(page);
    readings.push({
      i: readings.length,
      label: LIVE_REGIONS,
      // PRE shows what was already there; later phases show what changed since (§21.3 step 8).
      ...(phase === "pre"
        ? { kind: "text", value: lines.join("\n") }
        : { kind: "region_diff", value: diffLines(liveBefore, lines) }),
      phase,
      tMs,
      bbox: null,
    });
  };

  let tTriggerMs = 0;
  try {
    await run({ op: "goto", path: "/cart" });
    await sleep(SETTLE_MS);
    for (const step of clip.setup) {
      await run(step);
      await sleep(SETTLE_MS);
    }
    const liveBefore = await liveLines(page);
    await read("pre", liveBefore);
    for (const [n, step] of clip.trigger.entries()) await run(step, n === clip.trigger.length - 1);
    tTriggerMs = stepLog.at(-1)!.tMs;

    const offsets = [...new Set([...POST_OFFSETS_MS, clip.criterion.timingMs ?? 0])].sort(
      (a, b) => a - b,
    );
    for (const offset of offsets) {
      // setTimeout can fire up to 1 ms early by Date.now()'s clock, so wait until the time is reached.
      while (Date.now() < tTriggerMs + offset) await sleep(tTriggerMs + offset - Date.now());
      await read("post", liveBefore);
      if (offset === SHOT_OFFSET_MS && options.shotPath) {
        await page.screenshot({ path: options.shotPath });
      }
    }
    if (clip.criterion.persistence) {
      await run({ op: "reload" });
      await sleep(SETTLE_MS);
      await read("after_reload", liveBefore);
    }
    await sleep(TAIL_MS); // so the video ends on the final state
  } finally {
    await context.close();
  }

  if (options.videoDir) renameSync(await page.video()!.path(), `${options.videoDir}/raw.webm`);
  const inWindow = (t: number) => t >= tTriggerMs - 1000;
  return {
    clipId: clip.id,
    laneStartMs,
    tTriggerMs,
    stepLog,
    readings,
    consoleErrorCount: consoleErrors.filter(inWindow).length,
    failedRequestCount: failedRequests.filter(inWindow).length,
  };
}

async function act(page: Page, step: Step, origin: string, clip: Clip): Promise<void> {
  switch (step.op) {
    case "goto": {
      // The variant goes in the URL but not in the step log, so the judges never see the
      // planted behavior's name; only the page itself.
      const url = new URL(step.path, origin);
      url.searchParams.set("variant", clip.variant);
      await page.goto(url.href);
      return;
    }
    case "click":
      await locate(page, step.target).click();
      return;
    case "fill":
      await locate(page, step.target).fill(step.value);
      return;
    case "reload":
      await page.reload();
      return;
  }
}

function locate(page: Page, target: Target): Locator {
  return target.by === "testId"
    ? page.getByTestId(target.id)
    : page.getByRole(
        target.role as AriaRole,
        target.name === undefined ? {} : { name: target.name },
      );
}

/** §21.3: innerText + bbox, or kind=absent when the element isn't on the page or isn't visible. */
async function readElement(
  page: Page,
  watch: WatchTarget,
  phase: Phase,
  i: number,
): Promise<Reading> {
  const tMs = Date.now();
  const absent: Reading = {
    i,
    label: watch.label,
    kind: "absent",
    phase,
    tMs,
    value: null,
    bbox: null,
  };
  const element = locate(page, watch.target).first();
  try {
    // innerText returns the text of hidden elements too, so visibility decides presence.
    if ((await element.count()) === 0 || !(await element.isVisible())) return absent;
    const text = (await element.innerText({ timeout: 1000 })).replace(/\s+/g, " ").trim();
    const box = await element.boundingBox({ timeout: 1000 });
    const bbox = box && ([box.x, box.y, box.width, box.height].map(Math.round) as Reading["bbox"]);
    return { ...absent, kind: "text", value: text, bbox };
  } catch {
    return absent; // detached between the checks
  }
}

async function liveLines(page: Page): Promise<string[]> {
  const lines: string[] = [];
  for (const region of await page.locator(TOP_LEVEL_LIVE).all()) {
    lines.push(...snapshotLines(await region.ariaSnapshot()));
  }
  return lines;
}
