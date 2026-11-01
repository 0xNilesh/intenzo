// IntentBench's arms (§31, T6.3): what each one shows its judges, from a criterion's pack.
//   A  diff-only  the ticket, the diff and the criterion (review.ts): no browser data at all
//   B  readings   judge.v1's text alone: the step log, the readings and the baseline's; no images
//   C  frames     B, plus the annotated still and each judge video as stills at 2 fps
//   D  video      the worker's own bundle (§22.2): the annotated still and the judge videos
// B, C and D are core's judgeBundle() with media left out or swapped, sent through judgeRequest(),
// so they differ from the worker's judging only in the media.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Criterion } from "@intenzo/core";
import { judgeBundle, type JudgeSide } from "@intenzo/core/judge";
import type { ContentPart } from "@intenzo/core/models";

import { STILLS_FPS } from "./frames.ts";
import type { Take } from "./pack.ts";

export const ARMS = ["A", "B", "C", "D"] as const;
export type Arm = (typeof ARMS)[number];

/** B says what it leaves out, so a judge doesn't take a missing video for a broken one. */
export const NO_MEDIA_NOTE =
  "MEDIA: none. This bundle has no screenshot and no video: judge from the step log and the readings.";
const band = "The black band under each still shows its time since the recording started.";
export const PR_STILLS_HEADING = `FRAMES (this pull request): the video as stills, ${STILLS_FPS} per second. ${band}`;
export const BASE_STILLS_HEADING = `FRAMES (BASELINE, before this pull request): the video as stills, ${STILLS_FPS} per second. ${band}`;

/** One side of a take as the judges see it; `stills` are arm C's frames of its judge video. */
export interface ArmSide extends JudgeSide {
  stills?: string[];
}

/** A take of a pack, with its files' paths: `folder` is the take's folder in the pack. */
export function sideOf(folder: string, take: Take): JudgeSide {
  return {
    lane: take.lane,
    ...(take.judgeVideo && { judgeVideo: join(folder, take.judgeVideo) }),
    ...(take.annotatedShot && { annotatedShot: join(folder, take.annotatedShot) }),
  };
}

const still = (path: string): ContentPart => ({
  type: "image_url",
  image_url: { url: `data:image/jpeg;base64,${readFileSync(path).toString("base64")}` },
});

/** The user message's parts that arm B, C or D sends with judge.v1. */
export function armParts(
  arm: Exclude<Arm, "A">,
  criterion: Criterion,
  pr: ArmSide,
  base: ArmSide | null,
): ContentPart[] {
  switch (arm) {
    case "D":
      return judgeBundle(criterion, pr, base).parts;
    case "B": {
      const text = judgeBundle(criterion, { lane: pr.lane }, base && { lane: base.lane }).parts;
      return [...text, { type: "text", text: NO_MEDIA_NOTE }];
    }
    case "C": {
      const shot = { lane: pr.lane, ...(pr.annotatedShot && { annotatedShot: pr.annotatedShot }) };
      const parts = judgeBundle(criterion, shot, base && { lane: base.lane }).parts;
      // As D sends the base's video only when its lane completed (§22.2).
      const baseStills = base?.lane.status === "completed" ? (base.stills ?? []) : [];
      return [
        ...parts,
        ...(pr.stills?.length
          ? [{ type: "text" as const, text: PR_STILLS_HEADING }, ...pr.stills.map(still)]
          : []),
        ...(baseStills.length
          ? [{ type: "text" as const, text: BASE_STILLS_HEADING }, ...baseStills.map(still)]
          : []),
      ];
    }
  }
}
