import { decodeMaskToSVGPath } from "@meta-sam/parser";

import { costUsd } from "../models/pricing.ts";
import type { ModelPort } from "../models/port.ts";
import {
  pointPrompt,
  samCostUsd,
  SamTimeoutError,
  samVideo,
  type SamFrame,
  type SamVideoRequest,
} from "../models/sam.ts";
import {
  POINT_JSON_SCHEMA,
  POINT_SYSTEM,
  POINT_V1,
  PointReply,
  renderPoint,
} from "../prompts/point.v1.ts";

// SAM for a visual criterion's evidence (ARCHITECTURE §23, T5.2): Spark 1.3 points at what the
// criterion is about in the frame at Tt+1000, then SAM 3.1 tracks that point through the window,
// both ways, and each frame's mask becomes an outline. Anything short of masks is an outcome, not
// an error: the GIF falls back to the DOM outline (T5.1).

/** SAM's object on one frame: its mask's outline, in raster pixels, placed over its box. */
export interface FrameMask {
  /** Source pixels, x2 and y2 inclusive: the raster covers this box. */
  box: { x1: number; y1: number; x2: number; y2: number };
  /** An SVG path in the raster's pixels (@meta-sam/parser's decodeMaskToSVGPath). */
  path: string;
  rasterWidth: number;
  rasterHeight: number;
}

export interface SegmentInput {
  /** The window's frames as an H.264 MP4 at 10 fps, padded to SAM's 50-frame minimum. */
  clip: Uint8Array;
  /** Frames in the clip, the padding included. */
  clipFrames: number;
  /** The frame to point on (Tt+1000) and its PNG. */
  stillFrame: number;
  still: Uint8Array;
  width: number;
  height: number;
}

export interface SegmentResult {
  /** Frame index (in the clip) → the tracked object's mask; null when there's nothing to draw. */
  masks: Map<number, FrameMask> | null;
  outcome: "ok" | "not_found" | "timeout" | "failed";
  costUsd: number;
  /** What happened, for the log: the point, or why there are no masks. */
  detail: string;
}

export type Segmenter = (input: SegmentInput) => Promise<SegmentResult>;

/** The model that points (vision, JSON replies); Spark over Wonder when both work (AGENTS §8). */
export const POINT_MODEL = "muse-spark-1.3";
/** §23: SAM gets 20 s, then the evidence falls back. */
export const SAM_TIMEOUT_MS = 20_000;

/** The masks of object 1, the one the point prompt names, frame by frame. */
export function masksOf(frames: readonly SamFrame[]): Map<number, FrameMask> {
  const masks = new Map<number, FrameMask>();
  for (const { frame, objects } of frames) {
    const object = objects.find((o) => o.id === 1) ?? objects[0];
    if (!object?.mask) continue;
    try {
      masks.set(frame, {
        box: object.box,
        path: decodeMaskToSVGPath(object.mask),
        rasterWidth: object.mask.width,
        rasterHeight: object.mask.height,
      });
    } catch {
      // An undecodable mask costs that frame its outline, nothing more.
    }
  }
  return masks;
}

export function samSegmenter(options: {
  port: ModelPort;
  apiKey: string;
  criterion: { text: string; expected: string };
  samTimeoutMs?: number;
  pointTimeoutMs?: number;
  /** The Meta API's base, for tests. */
  baseUrl?: string;
  /** The SAM call; tests pass a fake. */
  sam?: (request: SamVideoRequest) => Promise<{ frames: SamFrame[] }>;
}): Segmenter {
  return async (input) => {
    let spent = 0;
    const pointed = await options.port.call({
      stage: "evidence",
      model: POINT_MODEL,
      promptVersion: POINT_V1,
      messages: [
        { role: "system", content: POINT_SYSTEM },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: renderPoint(options.criterion, { width: input.width, height: input.height }),
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${Buffer.from(input.still).toString("base64")}`,
              },
            },
          ],
        },
      ],
      schema: PointReply,
      jsonSchema: { name: "point", schema: POINT_JSON_SCHEMA },
      reasoningEffort: "low",
      timeoutMs: options.pointTimeoutMs ?? 20_000,
    });
    spent += costUsd(POINT_MODEL, pointed.usage) ?? 0;
    if (!pointed.ok) {
      return { masks: null, outcome: "failed", costUsd: spent, detail: `point: ${pointed.error}` };
    }
    const { found, x, y } = pointed.output;
    if (!found) {
      return { masks: null, outcome: "not_found", costUsd: spent, detail: "nothing to point at" };
    }
    const at = `(${x}, ${y}) on frame ${input.stillFrame}`;
    try {
      // SAM bills its 50-frame minimum whether or not it answers in time: counted up front.
      spent += samCostUsd(input.clipFrames);
      const { frames } = await (options.sam ?? samVideo)({
        apiKey: options.apiKey,
        video: input.clip,
        prompt: pointPrompt({
          frame: input.stillFrame,
          x,
          y,
          width: input.width,
          height: input.height,
        }),
        timeoutMs: options.samTimeoutMs ?? SAM_TIMEOUT_MS,
        ...(options.baseUrl && { baseUrl: options.baseUrl }),
      });
      const masks = masksOf(frames);
      return masks.size
        ? { masks, outcome: "ok", costUsd: spent, detail: `${at}: ${masks.size} masks` }
        : { masks: null, outcome: "not_found", costUsd: spent, detail: `${at}: SAM found nothing` };
    } catch (err) {
      const timeout = err instanceof SamTimeoutError;
      return {
        masks: null,
        outcome: timeout ? "timeout" : "failed",
        costUsd: spent,
        detail: `${at}: ${(err as Error).message}`.slice(0, 300),
      };
    }
  };
}
