import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { startServer, type LoggedRequest, type TestServer } from "../browser/testing.ts";
import { metaModelPort } from "./meta.ts";
import { extractJson, type ModelRequest } from "./port.ts";

// The Meta Chat Completions protocol (dev.meta.ai/docs), against a local fake server.

const Act = z.object({ op: z.literal("click"), ref: z.string() });
const request: ModelRequest<z.infer<typeof Act>> = {
  stage: "navigate",
  model: "muse-wonder-1.0",
  promptVersion: "navigate.v1",
  messages: [{ role: "user", content: "Click Apply" }],
  schema: Act,
  jsonSchema: { name: "Act", schema: { type: "object" } },
  reasoningEffort: "low",
  maxTokens: 512,
};

const completion = (content: string, usage = { prompt_tokens: 10, completion_tokens: 5 }) =>
  JSON.stringify({
    choices: [{ message: { role: "assistant", content } }],
    usage: {
      ...usage,
      completion_tokens_details: { reasoning_tokens: 3 },
      prompt_tokens_details: { cached_tokens: 2 },
    },
  });

let server: TestServer | undefined;
afterEach(() => server?.close());

/** A fake API that answers each request with the next scripted [status, body]. */
async function fake(replies: [number, string][]) {
  let n = 0;
  server = await startServer("127.0.0.1", (_req, res) => {
    const [status, body] = replies[Math.min(n++, replies.length - 1)]!;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
  const waits: number[] = [];
  const port = metaModelPort({
    apiKey: "test-key",
    baseUrl: server.origin,
    sleep: async (ms) => waits.push(ms),
  });
  return { port, waits, requests: server.requests };
}

const sent = (r: LoggedRequest) => JSON.parse(r.body) as Record<string, unknown>;

describe("metaModelPort", () => {
  it("sends a strict json_schema request with the key and returns the checked reply", async () => {
    const { port, requests } = await fake([[200, completion('{"op":"click","ref":"e12"}')]]);
    const result = await port.call(request);
    expect(result).toMatchObject({ ok: true, output: { op: "click", ref: "e12" }, requests: 1 });
    expect(result.usage).toEqual({
      promptTokens: 10,
      cachedTokens: 2,
      completionTokens: 5,
      reasoningTokens: 3,
    });
    expect(requests[0]!.path).toBe("/chat/completions");
    expect(requests[0]!.headers.authorization).toBe("Bearer test-key");
    expect(sent(requests[0]!)).toMatchObject({
      model: "muse-wonder-1.0",
      max_completion_tokens: 512,
      reasoning_effort: "low",
      messages: request.messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: "Act", strict: true, schema: { type: "object" } },
      },
    });
  });

  it("retries a 429 and a 500 with backoff, then succeeds", async () => {
    const { port, waits } = await fake([
      [429, "{}"],
      [500, "{}"],
      [200, completion('{"op":"click","ref":"e1"}')],
    ]);
    expect(await port.call(request)).toMatchObject({ ok: true, requests: 3 });
    expect(waits).toEqual([500, 1500]);
  });

  it("retries Meta's transient 404 model_not_found, but no other 404 (#115)", async () => {
    const notFound =
      '{"error":{"code":"model_not_found","message":"The requested model was not found."}}';
    const flaky = await fake([
      [404, notFound],
      [404, notFound],
      [200, completion('{"op":"click","ref":"e1"}')],
    ]);
    expect(await flaky.port.call(request)).toMatchObject({ ok: true, requests: 3 });
    expect(flaky.waits).toEqual([500, 1500]);
    server?.close();
    const missing = await fake([[404, '{"error":{"code":"not_found"}}']]);
    expect(await missing.port.call(request)).toMatchObject({ ok: false, requests: 1 });
  });

  it("doesn't retry a 400", async () => {
    const { port } = await fake([[400, '{"error":"bad model"}']]);
    const result = await port.call(request);
    expect(result).toMatchObject({ ok: false, requests: 1 });
    expect(!result.ok && result.error).toContain("HTTP 400");
  });

  it("retries once with the problem appended when the reply doesn't match the schema", async () => {
    const { port, requests } = await fake([
      [200, completion('{"op":"tap","ref":"e1"}')],
      [200, completion('{"op":"click","ref":"e1"}')],
    ]);
    const result = await port.call(request);
    expect(result).toMatchObject({ ok: true, requests: 2 });
    expect(result.usage.promptTokens).toBe(20);
    const retry = sent(requests[1]!).messages as { role: string; content: string }[];
    expect(retry.at(-2)).toEqual({ role: "assistant", content: '{"op":"tap","ref":"e1"}' });
    expect(retry.at(-1)!.content).toMatch(/^That reply was not valid \(op: /);
  });

  it("gives up after the one retry", async () => {
    const { port } = await fake([[200, completion("not json")]]);
    const result = await port.call(request);
    expect(result).toMatchObject({ ok: false, requests: 2 });
    expect(!result.ok && result.error).toMatch(/^invalid reply: /);
  });
});

describe("extractJson", () => {
  it("reads plain, fenced and embedded JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a":1} done')).toEqual({ a: 1 });
    expect(() => extractJson("no json")).toThrow(/no JSON/);
  });
});
