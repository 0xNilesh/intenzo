import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { errors, type Browser, type Locator, type Page, type Request } from "playwright";

import {
  LaneResult,
  type ArtifactRef,
  type Criterion,
  type LoggedStep,
  type Reading,
  type SavedPath,
  type StepLogEntry,
  type Target,
} from "../schema/index.ts";
import { alignVideo, type Alignment } from "./align.ts";
import { annotateShot, type LabelledBox } from "./annotate.ts";
import { BoxPoller, type BoxSample } from "./boxes.ts";
import { now, showSyncMarker } from "./clock.ts";
import { acquireIdentity, openLane, VIEWPORT, type Lane } from "./lane.ts";
import { locate, Reader } from "./readings.ts";
import { Settler } from "./settle.ts";

// The observation protocol (ARCHITECTURE §21.3), identical for every criterion and both sides:
// identity → start page → settle → sync marker → setup (settle after each) → PRE → trigger, with
// Tt = the moment the last trigger action resolves and NO settle before +0 → POST at Tt+0, +1000,
// +3000 (+ timingMs) → plain screenshot at Tt+1000 → reload probe if `persistence` → close →
// align the video → annotate the screenshot offline → boxes.json and lane.json.

/** POST readings are taken at these offsets from Tt (§21.3 step 8), plus the criterion's timingMs. */
export const POST_OFFSETS_MS = [0, 1000, 3000] as const;
/** The plain screenshot that gets annotated offline (§21.3 step 9). */
export const SHOT_OFFSET_MS = 1000;
/** How long a step waits for its target to show up before the target counts as missing. */
export const STEP_TIMEOUT_MS = 5000;
const NAVIGATION_TIMEOUT_MS = 30_000;
/** So the video ends on the final state rather than mid-reading. */
const TAIL_MS = 500;
const SCROLL_PX = 600;

export interface RecordOptions {
  origin: string;
  side: "pr" | "base";
  criterion: Criterion;
  path: SavedPath;
  /** Take directory. The recorder writes raw.webm, trace.zip, shot.png, shot-annotated.png, boxes.json, lane.json here. */
  outDir: string;
  /** Session hook → ephemeral_user isolation; omitted → isolation "none". */
  identity?: { hookPath: string; secret: string };
  bypass?: string;
}

export interface Recording {
  /** humanVideo / judgeVideo / videoOffsets are left unset; T1.7's renderVideos fills them. */
  lane: LaneResult;
  /** absolute path of raw.webm */
  rawVideo: string | null;
  /** alignVideo() result for rawVideo (status "infra_error" if it failed) */
  alignment: Alignment;
  /** canonical ms the sync marker was painted */
  markerShownAt: number | null;
  /** plain Tt+1000 screenshot */
  shotPath: string | null;
  /** the same, with labelled watch boxes drawn OFFLINE from the readings' bboxes */
  annotatedShotPath: string | null;
  boxTrack: BoxSample[];
  /**
   * What went wrong, when something did: why the lane didn't complete (a failed step's error is
   * also in the step log), or a file that couldn't be produced. Not part of LaneResult.
   */
  error?: string;
}

type StepPhase = "setup" | "trigger" | "probe";
type LaneStatus = LaneResult["status"];

/** A step that failed, with the lane status it leads to and its index in the step log. */
class StepError extends Error {
  readonly status: LaneStatus;
  readonly index: number;

  constructor(message: string, status: LaneStatus, index: number) {
    super(message);
    this.name = "StepError";
    this.status = status;
    this.index = index;
  }
}

/** A setup step failing → setup_failed; the trigger control not found → trigger_absent. */
function failureStatus(phase: StepPhase, err: unknown): LaneStatus {
  if (phase === "setup") return "setup_failed";
  if (phase === "trigger" && err instanceof MissingTarget) return "trigger_absent";
  return "error";
}

class MissingTarget extends Error {}

/** Records one criterion on one side (§21.3) into `outDir`. Never throws for app-side failures. */
export async function recordCriterion(
  browser: Browser,
  options: RecordOptions,
): Promise<Recording> {
  const { criterion, path } = options;
  if (path.criterionId !== criterion.id) {
    throw new Error(`the path is for ${path.criterionId}, the criterion is ${criterion.id}`);
  }
  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  const videoDir = join(outDir, ".video");
  const files = {
    video: join(outDir, "raw.webm"),
    trace: join(outDir, "trace.zip"),
    shot: join(outDir, "shot.png"),
    annotated: join(outDir, "shot-annotated.png"),
    boxes: join(outDir, "boxes.json"),
    lane: join(outDir, "lane.json"),
  };

  let lane: Lane;
  try {
    lane = await openLane(browser, {
      origin: options.origin,
      videoDir,
      tracePath: files.trace,
      ...(options.bypass && { bypass: options.bypass }),
    });
  } catch (err) {
    // No browser context at all: nothing was recorded.
    return finish({ status: "error", error: messageOf(err), laneStartMs: now() });
  }
  const laneStartMs = now(); // the page, and so its video, has just started
  const { page, context } = lane;
  context.setDefaultTimeout(STEP_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

  const consoleErrors: number[] = [];
  const failedRequests: number[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(now());
  });
  page.on("pageerror", () => consoleErrors.push(now()));
  context.on("requestfailed", (request) => {
    if (!cancelled(request)) failedRequests.push(now());
  });
  context.on("response", (response) => {
    if (response.status() >= 400) failedRequests.push(now());
  });

  // Both go in before the first navigation, so they're on every document the lane loads.
  const poller = await BoxPoller.install(context, path.watch);
  const settler = await Settler.install(context, lane.origin);
  const reader = new Reader(page, path.watch);

  const stepLog: StepLogEntry[] = [];
  const run = async (step: LoggedStep, phase: StepPhase): Promise<number> => {
    await poller.drain(page); // a navigation would drop the samples still in the page
    const trigger = phase === "trigger";
    const leftBefore = lane.offOriginNavigations.length;
    try {
      await act(page, lane.origin, step);
    } catch (err) {
      const error = messageOf(err);
      stepLog.push({ tMs: now(), step, ok: false, trigger, error });
      throw new StepError(error, failureStatus(phase, err), stepLog.length - 1);
    }
    const tMs = now(); // for the last trigger step, this is Tt
    const left = lane.offOriginNavigations.slice(leftBefore);
    if (left.length > 0) {
      // Off-origin pages fail the lane: the evidence wouldn't be the app's.
      const error = `the page left ${lane.origin} for ${left[0]}`;
      stepLog.push({ tMs, step, ok: false, trigger, error });
      throw new StepError(error, "error", stepLog.length - 1);
    }
    stepLog.push({ tMs, step, ok: true, trigger });
    return tMs;
  };

  let status: LaneStatus = "completed";
  let failedStepIndex: number | undefined;
  let error: string | undefined;
  let markerShownAt: number | null = null;
  let tTriggerMs: number | null = null;
  let windowStart: number | null = null;
  let windowEnd: number | null = null;
  let shotReadings: Reading[] | null = null;

  try {
    if (options.identity) await acquireIdentity(lane, options.identity);

    const [first, ...rest] = path.setup;
    const startsWithGoto = first?.op === "goto";
    await run(startsWithGoto ? first : { op: "goto", path: "/" }, "setup");
    await settler.settle(page);
    markerShownAt = await showSyncMarker(page);
    for (const step of startsWithGoto ? rest : path.setup) {
      await run(step, "setup");
      await settler.settle(page);
    }

    await poller.drain(page);
    await reader.read("pre");

    windowStart = now();
    let tt = 0;
    for (const step of path.trigger) tt = await run(step, "trigger");
    // No settle here: +0 is the state the user sees the moment the action lands.
    tTriggerMs = tt;
    for (const offset of postOffsets(criterion)) {
      await until(tt + offset);
      const batch = await reader.read("post");
      await poller.drain(page);
      if (offset === SHOT_OFFSET_MS) {
        await page.screenshot({ path: files.shot });
        shotReadings = batch;
      }
    }
    windowEnd = now();

    if (criterion.persistence) {
      await run({ op: "reload" }, "probe");
      await settler.settle(page);
      await reader.read("after_reload");
    }
  } catch (err) {
    error = messageOf(err);
    status = err instanceof StepError ? err.status : "error";
    if (err instanceof StepError) failedStepIndex = err.index;
  }
  windowEnd ??= now();

  await sleep(TAIL_MS);
  await poller.drain(page);
  // A late redirect (after the last step) still means the evidence isn't the app's.
  if (status === "completed" && lane.offOriginNavigations.length > 0) {
    status = "error";
    error = `the page left ${lane.origin} for ${lane.offOriginNavigations[0]}`;
  }

  let closed: Awaited<ReturnType<Lane["close"]>> = { videoPath: null, tracePath: null };
  try {
    closed = await lane.close();
  } catch (err) {
    error ??= `couldn't close the lane: ${messageOf(err)}`;
  }
  let rawVideo: string | null = null;
  if (closed.videoPath) {
    renameSync(closed.videoPath, files.video);
    rawVideo = files.video;
  }
  rmSync(videoDir, { recursive: true, force: true });

  const alignment: Alignment = rawVideo
    ? alignVideo({
        video: rawVideo,
        ...(markerShownAt !== null && { markerShownAt }),
        ...(closed.tracePath && { trace: closed.tracePath }),
      })
    : { status: "infra_error", reason: "the lane recorded no video" };

  let annotatedShotPath: string | null = null;
  if (shotReadings) {
    // Every watch target that was on screen at Tt+1000, boxed where that reading found it.
    const boxes: LabelledBox[] = shotReadings.flatMap((r) =>
      r.bbox ? [{ label: r.label, bbox: r.bbox }] : [],
    );
    try {
      await annotateShot(browser, files.shot, boxes, files.annotated);
      annotatedShotPath = files.annotated;
    } catch (err) {
      error ??= `couldn't annotate the screenshot: ${messageOf(err)}`;
    }
  }

  const inWindow = (t: number) => windowStart !== null && t >= windowStart && t <= windowEnd!;
  return finish({
    status,
    laneStartMs,
    ...(failedStepIndex !== undefined && { failedStepIndex }),
    ...(error !== undefined && { error }),
    tTriggerMs,
    stepLog,
    readings: reader.readings,
    consoleErrorCount: consoleErrors.filter(inWindow).length,
    failedRequestCount: failedRequests.filter(inWindow).length,
    markerShownAt,
    rawVideo,
    alignment,
    shot: shotReadings ? files.shot : null,
    annotatedShotPath,
    boxTrack: poller.track,
    traceWritten: closed.tracePath !== null,
  });

  /** Writes boxes.json and lane.json, and validates the lane. */
  function finish(r: {
    status: LaneStatus;
    laneStartMs: number;
    failedStepIndex?: number;
    error?: string;
    tTriggerMs?: number | null;
    stepLog?: StepLogEntry[];
    readings?: Reading[];
    consoleErrorCount?: number;
    failedRequestCount?: number;
    markerShownAt?: number | null;
    rawVideo?: string | null;
    alignment?: Alignment;
    shot?: string | null;
    annotatedShotPath?: string | null;
    boxTrack?: BoxSample[];
    traceWritten?: boolean;
  }): Recording {
    const boxTrack = r.boxTrack ?? [];
    writeFileSync(files.boxes, `${JSON.stringify(boxTrack)}\n`);
    const runRoot = resolve(outDir, "../../..");
    const ref = (file: string, contentType: string): ArtifactRef => ({
      store: "private",
      path: relative(runRoot, file).split(sep).join("/"),
      contentType,
      bytes: statSync(file).size,
    });
    const result = LaneResult.parse({
      criterionId: criterion.id,
      side: options.side,
      status: r.status,
      ...(r.failedStepIndex !== undefined && { failedStepIndex: r.failedStepIndex }),
      laneStartMs: r.laneStartMs,
      tTriggerMs: r.tTriggerMs ?? null,
      ...(r.traceWritten && { trace: ref(files.trace, "application/zip") }),
      ...(r.annotatedShotPath && { annotatedShot: ref(r.annotatedShotPath, "image/png") }),
      boxTrack: ref(files.boxes, "application/json"),
      stepLog: r.stepLog ?? [],
      readings: r.readings ?? [],
      consoleErrorCount: r.consoleErrorCount ?? 0,
      failedRequestCount: r.failedRequestCount ?? 0,
      isolation: options.identity ? "ephemeral_user" : "none",
    });
    writeFileSync(files.lane, `${JSON.stringify(result, null, 2)}\n`);
    return {
      lane: result,
      rawVideo: r.rawVideo ?? null,
      alignment: r.alignment ?? { status: "infra_error", reason: "the lane recorded no video" },
      markerShownAt: r.markerShownAt ?? null,
      shotPath: r.shot ?? null,
      annotatedShotPath: r.annotatedShotPath ?? null,
      boxTrack,
      ...(r.error !== undefined && { error: r.error }),
    };
  }
}

/** The POST offsets for a criterion: 0, 1000 and 3000 ms, plus its timing claim. */
export function postOffsets(criterion: Pick<Criterion, "timingMs">): number[] {
  const all = new Set<number>([
    ...POST_OFFSETS_MS,
    ...(criterion.timingMs ? [criterion.timingMs] : []),
  ]);
  return [...all].sort((a, b) => a - b);
}

/** Sleeps until the canonical clock reaches `t`. Node's timers can fire a millisecond early. */
async function until(t: number): Promise<void> {
  for (let left = t - now(); left > 0; left = t - now()) await sleep(Math.ceil(left));
}

/** Runs one step (§20.2) the way the navigator would, through durable targets. */
async function act(page: Page, origin: string, step: LoggedStep): Promise<void> {
  switch (step.op) {
    case "goto": {
      const url = new URL(step.path, origin);
      if (url.origin !== origin) throw new Error(`goto leaves the app: ${step.path}`);
      await page.goto(url.href);
      return;
    }
    case "click":
      if (step.target.by === "point") return page.mouse.click(...pointOf(step.target));
      return (await find(page, step.target)).click();
    case "fill":
      if (step.target.by === "point") {
        await page.mouse.click(...pointOf(step.target));
        await page.keyboard.press("ControlOrMeta+A");
        return page.keyboard.insertText(step.value);
      }
      return (await find(page, step.target)).fill(step.value);
    case "select":
      await (await find(page, step.target)).selectOption(step.option);
      return;
    case "press":
      return page.keyboard.press(step.key);
    case "scroll":
      if (step.target) {
        if (step.target.by === "point") await page.mouse.move(...pointOf(step.target));
        else await (await find(page, step.target)).hover();
      }
      return page.mouse.wheel(0, step.direction === "down" ? SCROLL_PX : -SCROLL_PX);
    case "wait":
      await sleep(step.ms);
      return;
    case "back":
      await page.goBack();
      return;
    case "reload":
      await page.reload();
      return;
  }
}

/** The step's element, once it's visible. A target that never shows up is a MissingTarget. */
async function find(page: Page, target: Target): Promise<Locator> {
  const locator = locate(page, target);
  try {
    await locator.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof errors.TimeoutError) {
      throw new MissingTarget(`no ${describeTarget(target)} on the page`, { cause: err });
    }
    throw err;
  }
  return locator;
}

/** A vision-fallback point, scaled from the viewport it was found in to the lane's. */
function pointOf(target: Extract<Target, { by: "point" }>): [number, number] {
  const [width, height] = target.viewport;
  return [(target.x * VIEWPORT.width) / width, (target.y * VIEWPORT.height) / height];
}

function describeTarget(target: Target): string {
  switch (target.by) {
    case "testId":
      return `test id "${target.id}"`;
    case "role":
      return `${target.role} "${target.name}"${target.nth === undefined ? "" : ` #${target.nth}`}`;
    case "label":
      return `field labelled "${target.text}"`;
    case "placeholder":
      return `field with placeholder "${target.text}"`;
    case "css":
      return `element matching ${target.selector}`;
    case "point":
      return `point (${target.x}, ${target.y})`;
  }
}

/** Requests the browser cancelled itself (a navigation superseded them): not failures. */
function cancelled(request: Request): boolean {
  return request.failure()?.errorText.includes("ERR_ABORTED") ?? false;
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0]!;
}
