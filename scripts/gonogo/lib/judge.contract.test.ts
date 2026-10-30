import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { request } from "../../probe/lib/http.ts";
import { BACKOFF_MS, callJudge, judgeSpecs, requestBody, type JudgeSpec } from "./judge.ts";

// The judge client against a local fake of an OpenAI-compatible Chat Completions host (the shape
// both api.meta.ai and Baseten serve). No real model is called.

interface Reply {
  status: number;
  body: unknown;
}

let server: Server;
let url = "";
let replies: Reply[] = [];
let received: { auth: string | undefined; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      received.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      const reply = replies.shift() ?? { status: 500, body: { error: "no scripted reply" } };
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  replies = [];
  received = [];
});

const ANSWER = {
  verdict: "fail",
  targetCorrect: true,
  citedReadings: [2],
  citedValue: "$50.00",
  atMs: 2023,
  observed: "The total stayed at $50.00.",
};
const completion = (content: string, usage = { prompt_tokens: 3000, completion_tokens: 900 }) => ({
  status: 200,
  body: { choices: [{ message: { role: "assistant", content } }], usage },
});
const media = { imageUrl: "data:image/png;base64,AA==", videoUrl: "data:video/mp4;base64,AA==" };
const waits: number[] = [];
const deps = { request, sleep: async (ms: number) => void waits.push(ms) };
const spec = (which: 0 | 1): JudgeSpec => ({ ...judgeSpecs()[which], url, apiKey: "test-key" });

describe("callJudge against a fake Chat Completions host", () => {
  it("Spark 1.3: sends strict json_schema, the bundle and the video, and reads the verdict", async () => {
    replies = [completion(JSON.stringify(ANSWER))];
    const call = await callJudge(spec(1), requestBody(spec(1), "BUNDLE", media, "low"), deps);

    expect(call).toMatchObject({ output: ANSWER, requests: 1 });
    expect(call.usage).toMatchObject({ promptTokens: 3000, completionTokens: 900 });
    const [{ auth, body }] = received as [(typeof received)[number]];
    expect(auth).toBe("Bearer test-key");
    expect(body).toMatchObject({
      model: "muse-spark-1.3",
      reasoning_effort: "low",
      response_format: { type: "json_schema", json_schema: { name: "JudgeOutput", strict: true } },
    });
    expect(JSON.stringify(body)).toContain('"video_url":{"url":"data:video/mp4;base64,AA=="}');
  });

  it("Spark Open: no response_format; retries a 429 with backoff and reads JSON out of prose", async () => {
    waits.length = 0;
    replies = [
      { status: 429, body: { error: "rate limited" } },
      completion(`Verdict below.\n\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``),
    ];
    const call = await callJudge(spec(0), requestBody(spec(0), "BUNDLE", media), deps);

    expect(call).toMatchObject({ output: ANSWER, requests: 2 });
    expect(waits).toEqual([BACKOFF_MS[0]]);
    expect(received[1]!.body).not.toHaveProperty("response_format");
    expect(received[1]!.body).toHaveProperty("model", "meta-models/muse-spark-open");
  });

  it("retries an invalid reply once, appending what was wrong (§14)", async () => {
    replies = [
      completion(JSON.stringify({ ...ANSWER, verdict: "maybe" })),
      completion(JSON.stringify(ANSWER)),
    ];
    const call = await callJudge(spec(0), requestBody(spec(0), "BUNDLE", media), deps);

    expect(call).toMatchObject({ output: ANSWER, requests: 2 });
    expect(call.usage.promptTokens).toBe(6000); // both replies are billed
    const retry = received[1]!.body.messages as { role: string; content: unknown }[];
    expect(retry.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(retry[3]!.content).toMatch(/^That reply was not valid \(verdict: .*\)/);
  });

  it("gives up after the retry, and doesn't retry a 400", async () => {
    replies = [completion("I think it fails."), completion("Still no JSON, sorry.")];
    const twice = await callJudge(spec(0), requestBody(spec(0), "B", media), deps);
    expect(twice).toMatchObject({ output: null, requests: 2 });
    expect(twice.error).toMatch(/^no valid JudgeOutput after a retry/);

    replies = [{ status: 400, body: { error: { message: "Unsupported parameter" } } }];
    const rejected = await callJudge(spec(1), requestBody(spec(1), "B", media), deps);
    expect(rejected).toMatchObject({ output: null, requests: 1 });
    expect(rejected.error).toMatch(/^HTTP 400: .*Unsupported parameter/);
  });

  it("makes no request without a key", async () => {
    const call = await callJudge(
      { ...spec(1), apiKey: undefined },
      requestBody(spec(1), "B", media),
      deps,
    );
    expect(call).toMatchObject({ output: null, requests: 0, error: "META_API_KEY is not set" });
    expect(received).toHaveLength(0);
  });
});
