import { readFileSync } from "node:fs";

import { describeStep } from "../browser/video.ts";
import type { ContentPart } from "../models/port.ts";
import { BASE_VIDEO_HEADING, PR_VIDEO_HEADING, SCREENSHOT_QUESTION } from "../prompts/judge.v1.ts";
import { untrusted } from "../prompts/untrusted.ts";
import type { Criterion, LaneResult, Reading } from "../schema/index.ts";

// The judge bundle (ARCHITECTURE §22.2), the same for both judges: the criterion (with the PM's
// words), the PR lane's step log in canonical time with the TRIGGER marked, its readings, the
// annotated Tt+1000 still, the PR judge video (canonical time burned in, §21.4), the baseline
// (its readings and video, or where its trigger was missing), and the trigger window's counts.
// Media go inline as data URLs; both judges take video (DECISIONS 2026-10-30, T0.2b).

export interface JudgeSide {
  lane: LaneResult;
  /** judge.mp4 on disk (960×540, 4 fps, time band). */
  judgeVideo?: string;
  /** shot-annotated.png on disk (PR side). */
  annotatedShot?: string;
}

export interface JudgeBundle {
  text: string;
  /** The user message: the text, then each medium with its heading. */
  parts: ContentPart[];
}

const at = (lane: LaneResult, tMs: number) => Math.round(tMs - lane.laneStartMs);

function stepLog(lane: LaneResult): string[] {
  const tt = lane.tTriggerMs === null ? null : at(lane, lane.tTriggerMs);
  return lane.stepLog.map((s, k) => {
    const marker =
      s.trigger && tt !== null && at(lane, s.tMs) === tt ? `   ← TRIGGER (Tt = ${tt})` : "";
    const failed = s.ok ? "" : `   FAILED: ${s.error ?? "unknown error"}`;
    return `${k + 1}. t=${at(lane, s.tMs)}  ${describeStep(s.step)}${marker}${failed}`;
  });
}

function readingRows(lane: LaneResult, r: Reading, indexed: boolean): string[] {
  const t = at(lane, r.tMs);
  const tt = lane.tTriggerMs === null ? null : at(lane, lane.tTriggerMs);
  const when = r.phase === "post" && tt !== null ? `${t} (Tt+${t - tt})` : String(t);
  const lines = r.value === null ? ["—"] : r.value === "" ? ["(empty)"] : r.value.split("\n");
  const head = `${indexed ? `${r.i} | ` : ""}${r.label} | ${r.kind} | ${r.phase} | ${when} | ${lines[0]}`;
  // Extra lines of a multi-line value (a region diff) get their own rows, so each can be cited.
  const pad = indexed ? "  | | | | | " : "  | | | | ";
  return [head, ...lines.slice(1).map((line) => `${pad}${line}`)];
}

function readingsBlock(lane: LaneResult, indexed: boolean): string[] {
  const tt = lane.tTriggerMs === null ? "none" : String(at(lane, lane.tTriggerMs));
  return [
    `READINGS (t = ms since the recording started; Tt = ${tt})`,
    untrusted(
      "page",
      [
        `${indexed ? "i | " : ""}label | kind | phase | t | value`,
        ...lane.readings.flatMap((r) => readingRows(lane, r, indexed)),
      ].join("\n"),
    ),
  ];
}

function baselineBlock(base: LaneResult | null | undefined): string[] {
  if (!base) return ["BASELINE: none (no base preview was recorded)."];
  const head = "BASELINE (the base branch, before this pull request; for comparison only)";
  if (base.status !== "completed") {
    const k = base.failedStepIndex;
    const where =
      k === undefined ? "" : ` at step ${k + 1} (${describeStep(base.stepLog[k]!.step)})`;
    const what =
      base.status === "trigger_absent"
        ? "the trigger control isn't there"
        : `the lane ended ${base.status}`;
    return [head, `${what}${where}. Before that, the page read:`, ...readingsBlock(base, false)];
  }
  return [head, "STEP LOG", ...stepLog(base), "", ...readingsBlock(base, false)];
}

/** The bundle's text part (§22.2): everything but the images and videos. */
export function renderJudgeText(
  criterion: Criterion,
  pr: LaneResult,
  base?: LaneResult | null,
): string {
  const limits = [
    `kind: ${criterion.kind}`,
    `timingMs: ${criterion.timingMs ?? "none"}`,
    `persistence: ${criterion.persistence}`,
    `watched: ${criterion.watch.join(", ") || "nothing"}`,
  ];
  const ticket = [
    criterion.text,
    `Expected: ${criterion.expected}`,
    ...(criterion.sourceQuote ? [`The PM said: "${criterion.sourceQuote}"`] : []),
  ];
  return [
    `CRITERION ${criterion.id}`,
    untrusted("ticket", ticket.join("\n")),
    limits.join(" · "),
    "",
    "STEP LOG (ms since the recording started)",
    ...stepLog(pr),
    "",
    ...readingsBlock(pr, true),
    "",
    `Console errors around the trigger: ${pr.consoleErrorCount} · failed requests: ${pr.failedRequestCount}`,
    "",
    ...baselineBlock(base),
  ].join("\n");
}

const dataUrl = (path: string, type: string) =>
  `data:${type};base64,${readFileSync(path).toString("base64")}`;

/** The whole bundle: the text, the annotated still and the videos, as one user message's parts. */
export function judgeBundle(
  criterion: Criterion,
  pr: JudgeSide,
  base?: JudgeSide | null,
): JudgeBundle {
  const text = renderJudgeText(criterion, pr.lane, base?.lane);
  const parts: ContentPart[] = [{ type: "text", text }];
  if (pr.annotatedShot) {
    parts.push(
      { type: "text", text: SCREENSHOT_QUESTION },
      { type: "image_url", image_url: { url: dataUrl(pr.annotatedShot, "image/png") } },
    );
  }
  if (pr.judgeVideo) {
    parts.push(
      { type: "text", text: PR_VIDEO_HEADING },
      { type: "video_url", video_url: { url: dataUrl(pr.judgeVideo, "video/mp4") } },
    );
  }
  if (base?.judgeVideo && base.lane.status === "completed") {
    parts.push(
      { type: "text", text: BASE_VIDEO_HEADING },
      { type: "video_url", video_url: { url: dataUrl(base.judgeVideo, "video/mp4") } },
    );
  }
  return { text, parts };
}
