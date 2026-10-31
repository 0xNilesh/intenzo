import { setTimeout as sleep } from "node:timers/promises";

import {
  addUsage,
  extractJson,
  NO_USAGE,
  type ModelPort,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
} from "./port.ts";

// The Meta Model API's Chat Completions endpoint (dev.meta.ai/docs; OpenAI-style). T3.4 found that
// muse-wonder-1.0 accepts a strict json_schema response_format and reasoning_effort (DECISIONS
// 2026-10-31), like Spark 1.3 (T0.2).

export const META_BASE_URL = "https://api.meta.ai/v1";
/** §14: retry 429 and 5xx after these waits, within the call's timeout. */
export const BACKOFF_MS = [500, 1500, 4000];
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 4096;

export interface MetaPortOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
}

interface ChatReply {
  status: number;
  text: string;
  usage: ModelUsage;
}

export function metaModelPort(options: MetaPortOptions): ModelPort {
  const doFetch = options.fetch ?? fetch;
  const wait = options.sleep ?? sleep;
  const url = `${options.baseUrl ?? META_BASE_URL}/chat/completions`;

  return {
    async call<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
      const started = performance.now();
      const deadline = started + (request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      let usage = NO_USAGE;
      let requests = 0;
      const done = (raw: string) => ({
        raw,
        usage,
        requests,
        ms: Math.round(performance.now() - started),
      });

      // One request, retried on 429/5xx and network errors while there's time.
      const send = async (
        messages: ModelRequest<T>["messages"],
      ): Promise<ChatReply | { error: string; raw: string }> => {
        for (let attempt = 0; ; attempt++) {
          requests++;
          let reply: ChatReply | undefined;
          let failure = "";
          try {
            const res = await doFetch(url, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${options.apiKey}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(body(request, messages)),
              signal: AbortSignal.timeout(Math.max(1000, Math.round(deadline - performance.now()))),
            });
            const text = await res.text();
            if (res.ok) {
              const json = JSON.parse(text) as Record<string, unknown>;
              reply = { status: res.status, text: replyText(json), usage: usageOf(json) };
            } else {
              failure = `HTTP ${res.status}: ${text.slice(0, 300)}`;
              if (res.status !== 429 && res.status < 500) return { error: failure, raw: text };
            }
          } catch (err) {
            failure = `request failed: ${(err as Error).message}`;
          }
          if (reply) return reply;
          const backoff = BACKOFF_MS[attempt];
          if (backoff === undefined || performance.now() + backoff >= deadline)
            return { error: failure, raw: failure };
          await wait(backoff);
        }
      };

      let messages = request.messages;
      for (let attempt = 0; attempt < 2; attempt++) {
        const reply = await send(messages);
        if ("error" in reply) return { ok: false, error: reply.error, ...done(reply.raw) };
        usage = addUsage(usage, reply.usage);
        let problem: string;
        try {
          const parsed = request.schema.safeParse(extractJson(reply.text));
          if (parsed.success) return { ok: true, output: parsed.data, ...done(reply.text) };
          problem = parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ");
        } catch (err) {
          problem = (err as Error).message;
        }
        if (attempt === 1)
          return { ok: false, error: `invalid reply: ${problem}`, ...done(reply.text) };
        // §14: one retry with the problem appended.
        messages = [
          ...request.messages,
          { role: "assistant", content: reply.text },
          {
            role: "user",
            content: `That reply was not valid (${problem}). Reply again with only the corrected JSON.`,
          },
        ];
      }
      throw new Error("unreachable");
    },
  };
}

function body<T>(request: ModelRequest<T>, messages: ModelRequest<T>["messages"]) {
  return {
    model: request.model,
    max_completion_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(request.reasoningEffort && { reasoning_effort: request.reasoningEffort }),
    messages,
    ...(request.jsonSchema && {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: request.jsonSchema.name,
          strict: true,
          schema: request.jsonSchema.schema,
        },
      },
    }),
  };
}

function replyText(json: Record<string, unknown>): string {
  const choices = json.choices as { message?: { content?: unknown } }[] | undefined;
  const content = choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

function usageOf(json: Record<string, unknown>): ModelUsage {
  const u = (json.usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const details = (k: string) => (u[k] ?? {}) as Record<string, unknown>;
  return {
    promptTokens: n(u.prompt_tokens),
    cachedTokens: n(details("prompt_tokens_details").cached_tokens),
    completionTokens: n(u.completion_tokens),
    reasoningTokens: n(details("completion_tokens_details").reasoning_tokens),
  };
}
