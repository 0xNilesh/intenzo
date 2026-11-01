import { META_BASE_URL } from "./meta.ts";
import { readSse } from "./sse.ts";

// SAM 3.1 video segmentation (ARCHITECTURE §23): one streamed Responses API request with a prompt
// and an MP4, answered one text line per frame (dev.meta.ai/docs/sam/segmenting,
// /reading-segmentation). A point prompt tracks one object from the frame it names, both ways.

export const SAM_MODEL = "sam-3.1";
/** Every video request is billed for at least this many frames (dev.meta.ai/docs/pricing-rate-limits). */
export const SAM_MIN_FRAMES = 50;
/** $0.20 per 1,000 frames, read 2026-11-01. */
export const SAM_USD_PER_FRAME = 0.2 / 1000;

/** A mask as the wire carries it; @meta-sam/parser's decoders take this shape. */
export interface SamMask {
  encoding: "one_bit" | "lossless";
  /** The payload, its encoding marker ("!" or "~") first. */
  payload: string;
  width: number;
  height: number;
}

export interface SamObject {
  id: number;
  /** Source pixels; x2 and y2 are inclusive. The mask's raster covers this box. */
  box: { x1: number; y1: number; x2: number; y2: number };
  confidence: number | null;
  mask: SamMask | null;
}

export interface SamFrame {
  /** Zero-based, in the clip sent. A frame without the object has no line. */
  frame: number;
  objects: SamObject[];
}

/** One object to track: a positive point on a frame of a w × h video. */
export function pointPrompt(p: {
  frame: number;
  x: number;
  y: number;
  width: number;
  height: number;
}): string {
  const x = Math.min(p.width - 1, Math.max(0, Math.round(p.x)));
  const y = Math.min(p.height - 1, Math.max(0, Math.round(p.y)));
  return `<${p.frame}f>1<|point;x=${x};y=${y};w=${p.width};h=${p.height}|>`;
}

/** What a request costs: its frames, never fewer than SAM_MIN_FRAMES. */
export function samCostUsd(frames: number): number {
  return Math.max(SAM_MIN_FRAMES, frames) * SAM_USD_PER_FRAME;
}

// The base85 alphabet leaves out "|", so the first "|>" always closes a token.
const RECORD = /(\d+)<\|box;([^|]*)\|>(?:<\|mask;([^|]*)\|>)?/g;

function fields(s: string): Record<string, string> {
  return Object.fromEntries(
    s
      .split(";")
      .filter((part) => part.includes("="))
      .map((part) => [part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1)]),
  );
}

function parseMask(s: string): SamMask | null {
  const at = s.indexOf("data=");
  const data = /^(\d+),(\d+),([~!].*)$/.exec(at === -1 ? "" : s.slice(at + 5));
  if (!data) return null;
  return {
    encoding: data[3]!.startsWith("!") ? "one_bit" : "lossless",
    payload: data[3]!,
    height: Number(data[1]),
    width: Number(data[2]),
  };
}

/** The frame lines of SAM's output text. Lines that aren't frames are skipped. */
export function parseSamText(text: string): SamFrame[] {
  const frames: SamFrame[] = [];
  for (const line of text.split("\n")) {
    const marker = /^<(\d+)f>/.exec(line.trim());
    if (!marker) continue;
    const objects = [...line.trim().slice(marker[0].length).matchAll(RECORD)].map(
      ([, id, boxText, maskText]): SamObject => {
        const b = fields(boxText ?? "");
        return {
          id: Number(id),
          box: { x1: Number(b.x1), y1: Number(b.y1), x2: Number(b.x2), y2: Number(b.y2) },
          confidence: b.c === undefined ? null : Number(b.c),
          mask: maskText === undefined ? null : parseMask(maskText),
        };
      },
    );
    frames.push({ frame: Number(marker[1]), objects });
  }
  return frames;
}

/** SAM didn't answer in time: the caller falls back (§23). */
export class SamTimeoutError extends Error {
  constructor(ms: number) {
    super(`SAM didn't answer within ${ms} ms`);
    this.name = "SamTimeoutError";
  }
}

export interface SamVideoRequest {
  apiKey: string;
  /** H.264 MP4 (the API takes MP4 or MOV, not WebM). */
  video: Uint8Array;
  prompt: string;
  /** For the whole request, the stream included. */
  timeoutMs: number;
  baseUrl?: string;
}

export async function samVideo(
  request: SamVideoRequest,
): Promise<{ frames: SamFrame[]; ms: number }> {
  const started = performance.now();
  const signal = AbortSignal.timeout(request.timeoutMs);
  const body = {
    model: SAM_MODEL,
    stream: true,
    metadata: { include_confidence: "true" },
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: request.prompt },
          {
            type: "input_video",
            video_url: `data:video/mp4;base64,${Buffer.from(request.video).toString("base64")}`,
          },
        ],
      },
    ],
  };
  const lines: string[] = [];
  try {
    const res = await fetch(`${request.baseUrl ?? META_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`SAM: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    for await (const event of readSse(res.body)) {
      if (event.event === "response.output_text.delta") {
        const delta = (JSON.parse(event.data) as { delta?: unknown }).delta;
        if (typeof delta === "string") lines.push(delta);
      } else if (event.event === "error" || event.event === "response.failed") {
        throw new Error(`SAM: ${event.event}: ${event.data.slice(0, 200)}`);
      }
    }
  } catch (err) {
    if (signal.aborted) throw new SamTimeoutError(request.timeoutMs);
    throw err;
  }
  return { frames: parseSamText(lines.join("\n")), ms: performance.now() - started };
}
