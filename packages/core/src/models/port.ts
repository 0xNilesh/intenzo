import type { z } from "zod";

// The model port (ARCHITECTURE §6, §14). Every model call in core goes through it, so tests and
// the bench can swap the real APIs for recorded or scripted replies.

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface ModelRequest<T> {
  /** The pipeline stage, e.g. "navigate"; logged with every call. */
  stage: string;
  model: string;
  /** The prompt version, e.g. "navigate.v1"; logged with every call (§13). */
  promptVersion: string;
  messages: ModelMessage[];
  /** Checks the reply. Its input is the parsed JSON the model returned. */
  schema: z.ZodType<T>;
  /** A strict JSON schema for the reply, sent as response_format when the model supports it. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  /** For the whole call, retries included. */
  timeoutMs?: number;
}

export interface ModelUsage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

export const NO_USAGE: ModelUsage = {
  promptTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
};

export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

interface Outcome {
  /** The last reply's text, or the error body. */
  raw: string;
  usage: ModelUsage;
  /** Wall time, retries included. */
  ms: number;
  /** HTTP requests made. */
  requests: number;
}

export type ModelResult<T> =
  (Outcome & { ok: true; output: T }) | (Outcome & { ok: false; error: string });

export interface ModelPort {
  call<T>(request: ModelRequest<T>): Promise<ModelResult<T>>;
}

/** The JSON object in a reply, tolerating a ```json fence or text around it. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)?.[1];
    if (fenced) return JSON.parse(fenced);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("the reply has no JSON object");
  }
}
