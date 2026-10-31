// The Phase 2 gate's checks on a hosted run (ROADMAP P2 gate): the lanes Modal recorded must read
// what the P1 ground truth says, and cite their videos so the report can play them.
import type { LaneResult } from "@intenzo/core";

import { compareLane, type SideTruth } from "./p1.ts";

/** P1's ground truth, plus what a hosted lane adds: its human video, placed on the clock (§21.4). */
export function hostedLaneProblems(
  truth: SideTruth,
  lane: LaneResult | undefined,
  offsetsMs: readonly number[],
): string[] {
  if (!lane) return ["not recorded"];
  const problems = compareLane(truth, lane, offsetsMs);
  if (lane.humanVideo?.contentType !== "video/mp4") problems.push("no human video (video/mp4)");
  if (!lane.videoOffsets) problems.push("no video offsets");
  return problems;
}

/** The video URLs on a report page (/r/{runId}), in page order, with their HTML entities undone. */
export function videoSources(html: string): string[] {
  return [...html.matchAll(/<video\b[^>]*?\ssrc="([^"]+)"/g)].map((m) =>
    m[1]!.replaceAll("&amp;", "&"),
  );
}
