import { metaKey } from "../lib/env.ts";
import { parseJson, pickLimits, type HttpResult } from "../lib/http.ts";
import { asString, dig } from "../lib/json.ts";
import { TRUTH } from "../lib/media.ts";
import { capability, failed, missingKey, type Outcome, type Probe } from "../lib/probe.ts";
import { REQUIRED } from "../lib/results.ts";
import { iou, parseSamOutput, type SamFrame } from "../lib/sam-format.ts";
import { shapeOf } from "../lib/shape.ts";
import { readSse } from "../lib/sse.ts";
import { latency } from "../lib/stats.ts";
import { META_BASE, bearer, dataUrl } from "./meta-api.ts";

// SAM 3.1 runs on the Responses API with one prompt part and one media part; output streams as
// text lines, one per frame (dev.meta.ai/docs/sam/segmenting, /reading-segmentation).
const MODEL = "sam-3.1";
// Every video request bills at least 50 frames, so video capabilities take fewer samples.
const VIDEO_SAMPLES = 3;
const MIN_IOU = 0.7;

interface SamRun {
  ms: number;
  firstDeltaMs: number | null;
  text: string;
  frames: SamFrame[];
  events: string[];
  headers: Headers;
}

export const probeSam: Probe = async (ctx) => {
  const key = metaKey();
  if (!key) return missingKey(ctx, "sam-3.1", REQUIRED["sam-3.1"], "META_API_KEY");
  const { width, height } = TRUTH.video;
  const box = TRUTH.redBox;
  const image = { type: "input_image", image_url: dataUrl(ctx.media.cartPng, "image/png") };
  const video = { type: "input_video", video_url: dataUrl(ctx.media.cartMp4, "video/mp4") };
  const center = { x: Math.round((box.x1 + box.x2) / 2), y: Math.round((box.y1 + box.y2) / 2) };

  const probe = async (n: number, prompt: string, media: unknown, minFrames: number) => {
    const body = {
      model: MODEL,
      stream: true,
      metadata: { include_confidence: "true" },
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: prompt }, media] },
      ],
    };
    const samples: number[] = [];
    let last: SamRun | undefined;
    for (let i = 0; i < n; i++) {
      const run = await samStream(key, body);
      if ("failure" in run) return failed(run.failure, body);
      samples.push(run.ms);
      last = run;
    }
    return summarize(body, samples, last!, minFrames);
  };

  const summarize = (body: unknown, samples: number[], run: SamRun, minFrames: number): Outcome => {
    const ious = run.frames.map((f) => Math.max(0, ...f.objects.map((o) => iou(o.box, box))));
    const tracked = ious.filter((v) => v >= MIN_IOU).length;
    const first = run.frames[0]?.objects[0];
    return {
      status: "ok",
      latencyMs: latency(samples),
      correct: run.frames.length >= minFrames && tracked >= minFrames,
      request: shapeOf(body),
      response: {
        events: run.events,
        frames: run.frames.length,
        firstLine: run.text.split("\n")[0]?.slice(0, 200) ?? "",
      },
      limits: pickLimits(run.headers),
      notes: [
        `${run.frames.length} frame line(s); ${tracked} with IoU ≥ ${MIN_IOU} vs the red box`,
        `objects in first frame: ${run.frames[0]?.objects.length ?? 0}`,
        first?.mask ? `mask ${first.mask.h}x${first.mask.w} ${first.mask.encoding}` : "no mask",
        first?.box.c !== undefined ? `confidence ${first.box.c}` : "no confidence field",
        run.firstDeltaMs !== null ? `first frame after ${Math.round(run.firstDeltaMs)} ms` : "",
      ]
        .filter(Boolean)
        .join("; "),
    };
  };

  await capability(ctx, "sam-3.1", "image_text", () =>
    probe(ctx.samples, "red rectangle", image, 1),
  );
  const n = Math.min(ctx.samples, VIDEO_SAMPLES);
  const frames = TRUTH.video.frames - 5; // allow a few frames without a confident match
  await capability(ctx, "sam-3.1", "video_text", () => probe(n, "red rectangle", video, frames));
  await capability(ctx, "sam-3.1", "video_box", () =>
    probe(
      n,
      `<0f>1<|box;x1=${box.x1};y1=${box.y1};x2=${box.x2};y2=${box.y2};w=${width};h=${height}|>`,
      video,
      frames,
    ),
  );
  await capability(ctx, "sam-3.1", "video_point", () =>
    probe(n, `<0f>1<|point;x=${center.x};y=${center.y};w=${width};h=${height}|>`, video, frames),
  );
};

/** One streaming SAM request, collecting frame lines from response.output_text.delta events. */
export async function samStream(
  key: string,
  body: unknown,
  base: string = META_BASE,
): Promise<SamRun | { failure: HttpResult }> {
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(`${base}/responses`, {
      method: "POST",
      headers: { ...bearer(key), "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
  } catch (err) {
    const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return {
      failure: {
        status: 0,
        ok: false,
        ms: performance.now() - started,
        headers: new Headers(),
        body: text,
        text,
      },
    };
  }
  if (!res.ok || !res.body) {
    const text = await res.text();
    return {
      failure: {
        status: res.status,
        ok: false,
        ms: performance.now() - started,
        headers: res.headers,
        body: parseJson(text),
        text,
      },
    };
  }

  const lines: string[] = [];
  const events = new Set<string>();
  let firstDeltaMs: number | null = null;
  let streamError: string | undefined;
  for await (const event of readSse(res.body)) {
    events.add(event.event);
    if (event.event === "response.output_text.delta") {
      firstDeltaMs ??= performance.now() - started;
      lines.push(
        ...asString(dig(parseJson(event.data), "delta"))
          .split("\n")
          .filter(Boolean),
      );
    } else if (event.event === "error" || event.event === "response.failed") {
      streamError = event.data;
    }
  }
  const ms = performance.now() - started;
  if (streamError !== undefined) {
    return {
      failure: {
        status: res.status,
        ok: false,
        ms,
        headers: res.headers,
        body: parseJson(streamError),
        text: streamError,
      },
    };
  }
  const text = lines.join("\n");
  return {
    ms,
    firstDeltaMs,
    text,
    frames: parseSamOutput(text),
    events: [...events],
    headers: res.headers,
  };
}
