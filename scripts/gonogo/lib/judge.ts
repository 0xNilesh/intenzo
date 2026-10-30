import { setTimeout as sleep } from "node:timers/promises";

import { metaKey, sparkOpenEndpoint } from "../../probe/lib/env.ts";
import { errorText, request, type HttpResult, type RequestOptions } from "../../probe/lib/http.ts";
import { dig } from "../../probe/lib/json.ts";
import { META_BASE, chatText } from "../../probe/models/meta-api.ts";
import { JUDGE_JSON_SCHEMA, JUDGE_SYSTEM, SCREENSHOT_QUESTION, VIDEO_HEADING } from "./prompt.ts";
import { JudgeOutput } from "./schema.ts";

export type JudgeKey = "spark-open" | "spark-1.3";

export interface JudgeSpec {
  key: JudgeKey;
  name: string;
  /** Chat Completions endpoint. */
  url: string;
  apiKey: string | undefined;
  /** Where the key comes from, for the "missing key" message. */
  keyVar: string;
  model: string;
  /** Spark 1.3 takes a strict json_schema. Baseten: "All except Muse Spark Open support
   * structured outputs and JSON mode" (docs.baseten.co, Model APIs overview). */
  structured: boolean;
  maxTokensField: "max_tokens" | "max_completion_tokens";
}

/** Judge A (primary) and judge B, as ARCHITECTURE §4 and DECISIONS 2026-10-30 (T0.2b) settle. */
export function judgeSpecs(): [JudgeSpec, JudgeSpec] {
  const open = sparkOpenEndpoint();
  return [
    {
      key: "spark-open",
      name: "A · Spark Open",
      url: `${open.baseUrl}/chat/completions`,
      apiKey: open.key,
      keyVar: "BASETEN_API_KEY (or SPARK_OPEN_BASE_URL + SPARK_OPEN_API_KEY)",
      model: process.env.SPARK_OPEN_MODEL || "meta-models/muse-spark-open",
      structured: false,
      maxTokensField: "max_tokens",
    },
    {
      key: "spark-1.3",
      name: "B · Spark 1.3",
      url: `${META_BASE}/chat/completions`,
      apiKey: metaKey(),
      keyVar: "META_API_KEY",
      model: "muse-spark-1.3",
      structured: true,
      maxTokensField: "max_completion_tokens",
    },
  ];
}

/** Room for reasoning: both models reason before answering, and Spark Open defaults to xhigh. */
export const MAX_OUTPUT_TOKENS = 8192;
/** §14: retry 429 and 5xx with these waits, then give up. */
export const BACKOFF_MS = [500, 1500, 4000];
const TIMEOUT_MS = 120_000;

export interface Media {
  /** The annotated Tt+1000 screenshot as a PNG data URL. */
  imageUrl: string;
  /** The judge clip as an MP4 data URL. */
  videoUrl: string;
}

/** reasoning_effort values both hosts accept (dev.meta.ai/docs/reasoning; Baseten reasoning docs). */
export type Effort = "low" | "medium" | "high" | "xhigh";

/** The Chat Completions request for one judge: the same messages for both, §22.2. */
export function requestBody(spec: JudgeSpec, bundle: string, media: Media, effort?: Effort) {
  return {
    model: spec.model,
    [spec.maxTokensField]: MAX_OUTPUT_TOKENS,
    ...(effort && { reasoning_effort: effort }),
    messages: [
      { role: "system", content: JUDGE_SYSTEM },
      {
        role: "user",
        content: [
          { type: "text", text: bundle },
          { type: "text", text: SCREENSHOT_QUESTION },
          { type: "image_url", image_url: { url: media.imageUrl } },
          { type: "text", text: VIDEO_HEADING },
          // dev.meta.ai/docs/video-understanding: Chat Completions takes a video_url part.
          { type: "video_url", video_url: { url: media.videoUrl } },
        ],
      },
    ] as { role: string; content: unknown }[],
    ...(spec.structured && {
      response_format: {
        type: "json_schema",
        json_schema: { name: "JudgeOutput", strict: true, schema: JUDGE_JSON_SCHEMA },
      },
    }),
  };
}

export interface Usage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

export interface JudgeCall {
  output: JudgeOutput | null;
  error?: string;
  /** Wall time for the whole call, retries included. */
  ms: number;
  /** HTTP requests made. */
  requests: number;
  usage: Usage;
  /** The last reply's text (or error body), kept for reading the raw answer later. */
  raw: string;
}

export interface Deps {
  request: (url: string, options: RequestOptions) => Promise<HttpResult>;
  sleep: (ms: number) => Promise<unknown>;
}

const NO_USAGE: Usage = {
  promptTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
};

/**
 * Asks one judge. 429/5xx and dropped connections are retried with backoff; a reply that isn't a
 * valid JudgeOutput gets one retry with the validation error appended (§14). Never throws.
 */
export async function callJudge(
  spec: JudgeSpec,
  body: ReturnType<typeof requestBody>,
  deps: Deps = { request, sleep },
): Promise<JudgeCall> {
  const started = performance.now();
  let requests = 0;
  let usage = NO_USAGE;
  const done = (rest: Omit<JudgeCall, "ms" | "requests" | "usage">): JudgeCall => ({
    ...rest,
    ms: Math.round(performance.now() - started),
    requests,
    usage,
  });
  if (!spec.apiKey) return done({ output: null, error: `${spec.keyVar} is not set`, raw: "" });

  let messages = body.messages;
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const send = () => {
      requests++;
      return deps.request(spec.url, {
        headers: { Authorization: `Bearer ${spec.apiKey}` },
        json: { ...body, messages },
        timeoutMs: TIMEOUT_MS,
      });
    };
    let res = await send();
    for (const wait of BACKOFF_MS) {
      if (!(res.status === 429 || res.status >= 500 || res.status === 0)) break;
      await deps.sleep(wait);
      res = await send();
    }
    if (!res.ok) return done({ output: null, error: errorText(res), raw: res.text.slice(0, 2000) });
    usage = addUsage(usage, usageOf(res.body));
    const text = chatText(res.body);
    const parsed = parseJudgeOutput(text);
    if (parsed.ok) return done({ output: parsed.value, raw: text });
    problem = parsed.error;
    messages = [
      ...body.messages,
      { role: "assistant", content: text },
      {
        role: "user",
        content: `That reply was not valid (${problem}). Reply with only the JSON object.`,
      },
    ];
  }
  return done({ output: null, error: `no valid JudgeOutput after a retry: ${problem}`, raw: "" });
}

/** The first JSON object in a reply, after dropping <think> blocks and code fences. */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("no JSON object in the reply");
  return JSON.parse(cleaned.slice(start, end + 1));
}

export function parseJudgeOutput(
  text: string,
): { ok: true; value: JudgeOutput } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = extractJson(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const result = JudgeOutput.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues.map((i) => `${i.path.join(".") || "reply"}: ${i.message}`);
  return { ok: false, error: issues.join("; ") };
}

export function usageOf(body: unknown): Usage {
  const n = (...path: string[]) => {
    const value = dig(body, "usage", ...path);
    return typeof value === "number" ? value : 0;
  };
  return {
    promptTokens: n("prompt_tokens"),
    cachedTokens: n("prompt_tokens_details", "cached_tokens"),
    completionTokens: n("completion_tokens"),
    reasoningTokens: n("completion_tokens_details", "reasoning_tokens"),
  };
}

const addUsage = (a: Usage, b: Usage): Usage => ({
  promptTokens: a.promptTokens + b.promptTokens,
  cachedTokens: a.cachedTokens + b.cachedTokens,
  completionTokens: a.completionTokens + b.completionTokens,
  reasoningTokens: a.reasoningTokens + b.reasoningTokens,
});

/**
 * USD per million tokens. Spark 1.3: dev.meta.ai/docs/pricing-rate-limits. Spark Open on Baseten
 * is listed at the same rates (Baseten pricing page as of 2026-10-23). Reasoning bills as output.
 */
export const PRICE_PER_M = { input: 1.25, cachedInput: 0.15, output: 4.25 } as const;

export function costUsd(u: Usage): number {
  const uncached = Math.max(0, u.promptTokens - u.cachedTokens);
  return (
    (uncached * PRICE_PER_M.input +
      u.cachedTokens * PRICE_PER_M.cachedInput +
      u.completionTokens * PRICE_PER_M.output) /
    1_000_000
  );
}
