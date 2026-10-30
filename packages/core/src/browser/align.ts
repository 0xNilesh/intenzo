import { execFileSync } from "node:child_process";

import { findFirstFrameMs } from "./ffmpeg.ts";

// Aligns a lane's video with the canonical clock (ARCHITECTURE §21.4): video ms = canonical ms +
// offsetMs. The green marker is exact by construction. Without it, the trace's first screencast
// frame (its frameSwapWallTime is canonical time, and Playwright builds the video from those same
// frames) gives an estimate within about one frame. Without either, the lane is an infra_error:
// it's never judged on a misaligned video.

export type Alignment =
  | { status: "ok"; offsetMs: number; method: "marker" | "trace" }
  | { status: "infra_error"; reason: string };

export interface AlignInput {
  video: string;
  /** Canonical time the marker was first painted (showSyncMarker), if one was shown. */
  markerShownAt?: number;
  /** The lane's Playwright trace, for the fallback. */
  trace?: string;
}

export function alignVideo({ video, markerShownAt, trace }: AlignInput): Alignment {
  if (markerShownAt !== undefined) {
    const markerVideoMs = safely(() => findFirstFrameMs(video));
    if (markerVideoMs !== null && markerVideoMs !== undefined) {
      return { status: "ok", offsetMs: markerVideoMs - markerShownAt, method: "marker" };
    }
  }
  if (trace) {
    const firstFrameAt = safely(() => firstScreencastWallTime(trace));
    if (firstFrameAt !== null && firstFrameAt !== undefined) {
      return { status: "ok", offsetMs: -firstFrameAt, method: "trace" };
    }
  }
  return {
    status: "infra_error",
    reason: "couldn't align the video: no marker frame found and no usable trace",
  };
}

/** Canonical time of a trace's first screencast frame, or null if it has none. */
export function firstScreencastWallTime(trace: string): number | null {
  const events = execFileSync("unzip", ["-p", trace, "trace.trace"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  let first: number | null = null;
  for (const line of events.split("\n")) {
    if (!line.includes('"screencast-frame"')) continue;
    const wall = (JSON.parse(line) as { frameSwapWallTime?: unknown }).frameSwapWallTime;
    if (typeof wall === "number" && (first === null || wall < first)) first = wall;
  }
  return first;
}

function safely<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
