import { readFileSync } from "node:fs";

import { errorText, looksUnsupported, pickLimits, type HttpResult } from "./http.ts";
import type { Media } from "./media.ts";
import type { ModelKey, ProbeResult } from "./results.ts";
import { shapeOf } from "./shape.ts";
import { latency } from "./stats.ts";

export type Outcome = Omit<ProbeResult, "model" | "capability" | "at">;

export interface ProbeContext {
  /** Calls per capability for the latency p50. */
  samples: number;
  media: Media;
  record(result: Omit<ProbeResult, "at">): void;
}

export type Probe = (ctx: ProbeContext) => Promise<void>;

/** Runs one capability check and records its outcome. A thrown error becomes an `error` result. */
export async function capability(
  ctx: ProbeContext,
  model: ModelKey,
  name: string,
  run: () => Promise<Outcome>,
): Promise<void> {
  let outcome: Outcome;
  try {
    outcome = await run();
  } catch (err) {
    outcome = {
      status: "error",
      latencyMs: null,
      correct: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  ctx.record({ model, capability: name, ...outcome });
}

/** Records every capability of a model as `error` because its API key isn't configured. */
export function missingKey(
  ctx: ProbeContext,
  model: ModelKey,
  capabilities: readonly string[],
  variable: string,
): void {
  for (const name of capabilities) {
    ctx.record({
      model,
      capability: name,
      status: "error",
      latencyMs: null,
      correct: null,
      error: `${variable} is not set (copy .env.example to .env)`,
    });
  }
}

export interface Sampled {
  samples: number[];
  last: HttpResult;
}

/** Calls `call` n times (n >= 1) for a latency sample, stopping at the first failure. */
export async function sampled(
  n: number,
  call: () => Promise<HttpResult>,
): Promise<Sampled | { failure: HttpResult }> {
  const samples: number[] = [];
  let last: HttpResult | undefined;
  for (let i = 0; i < Math.max(1, n); i++) {
    last = await call();
    if (!last.ok) return { failure: last };
    samples.push(last.ms);
  }
  return { samples, last: last! };
}

export function succeeded(
  run: Sampled,
  requestBody: unknown,
  correct: boolean | null,
  notes?: string,
): Outcome {
  return {
    status: "ok",
    latencyMs: latency(run.samples),
    correct,
    request: shapeOf(requestBody),
    response: shapeOf(run.last.body),
    limits: pickLimits(run.last.headers),
    notes,
  };
}

export function failed(result: HttpResult, requestBody?: unknown): Outcome {
  return {
    status: looksUnsupported(result.status, result.text) ? "unsupported" : "error",
    latencyMs: result.status === 0 ? null : latency([result.ms]),
    correct: null,
    request: requestBody === undefined ? undefined : shapeOf(requestBody),
    response: shapeOf(result.body),
    limits: pickLimits(result.headers),
    error: errorText(result),
  };
}

/** A model answer, quoted and shortened for a result's notes. */
export function quote(answer: string, max = 160): string {
  const flat = answer.replace(/\s+/g, " ").trim();
  return JSON.stringify(flat.length > max ? `${flat.slice(0, max)}…` : flat);
}

/** A file as a Blob for multipart uploads. */
export function fileBlob(path: string, type: string): Blob {
  return new Blob([new Uint8Array(readFileSync(path))], { type });
}
