// Contract: SAM 3.1 streaming as documented (dev.meta.ai/docs/sam/segmenting): a Responses API
// request with a prompt and an MP4, answered as server-sent events, one frame line per
// response.output_text.delta, against a local fake server.
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { SamTimeoutError, samVideo } from "./sam.ts";

const BOX = "x1=899;y1=321;x2=958;y2=375;w=1280;h=720";
let server: Server | undefined;

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  return raw;
}

const sse = (res: ServerResponse, event: string, data: unknown) =>
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const VIDEO = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

describe("samVideo", () => {
  it("posts the prompt and the MP4 to /responses, streamed, and reads one frame per delta", async () => {
    let seen: Record<string, unknown> = {};
    const base = await serve(async (req, res) => {
      seen = {
        method: req.method,
        path: req.url,
        auth: req.headers.authorization,
        accept: req.headers.accept,
        body: JSON.parse(await bodyOf(req)),
      };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      sse(res, "response.created", {});
      sse(res, "response.output_text.delta", { delta: `<20f>1<|box;${BOX};c=0.96|>` });
      sse(res, "response.output_text.delta", { delta: `<21f>1<|box;${BOX};c=0.95|>\n` });
      sse(res, "response.completed", {});
      res.end();
    });
    const run = await samVideo({
      apiKey: "test-key",
      video: VIDEO,
      prompt: "<20f>1<|point;x=944;y=348;w=1280;h=720|>",
      timeoutMs: 5000,
      baseUrl: base,
    });
    expect(seen).toMatchObject({
      method: "POST",
      path: "/v1/responses",
      auth: "Bearer test-key",
      accept: "text/event-stream",
      body: {
        model: "sam-3.1",
        stream: true,
        metadata: { include_confidence: "true" },
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "<20f>1<|point;x=944;y=348;w=1280;h=720|>" },
              {
                type: "input_video",
                video_url: `data:video/mp4;base64,${Buffer.from(VIDEO).toString("base64")}`,
              },
            ],
          },
        ],
      },
    });
    expect(run.frames.map((f) => `${f.frame}:${f.objects[0]!.confidence}`)).toEqual([
      "20:0.96",
      "21:0.95",
    ]);
  });

  it("fails on an error status, saying which", async () => {
    const base = await serve((_, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "object prompts cannot be combined with a phrase" } }),
      );
    });
    await expect(
      samVideo({ apiKey: "k", video: VIDEO, prompt: "x", timeoutMs: 5000, baseUrl: base }),
    ).rejects.toThrow(/HTTP 400.*cannot be combined/);
  });

  it("fails on an error event in the stream", async () => {
    const base = await serve((_, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      sse(res, "response.output_text.delta", { delta: `<0f>1<|box;${BOX}|>` });
      sse(res, "response.failed", { error: { message: "video could not be decoded" } });
      res.end();
    });
    await expect(
      samVideo({ apiKey: "k", video: VIDEO, prompt: "x", timeoutMs: 5000, baseUrl: base }),
    ).rejects.toThrow(/response.failed.*could not be decoded/);
  });

  it("gives up after its timeout with a SamTimeoutError, even mid-stream", async () => {
    const base = await serve((_, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      sse(res, "response.output_text.delta", { delta: `<0f>1<|box;${BOX}|>` });
      // …and never another event.
    });
    const started = Date.now();
    const call = samVideo({
      apiKey: "k",
      video: VIDEO,
      prompt: "x",
      timeoutMs: 300,
      baseUrl: base,
    });
    await expect(call).rejects.toBeInstanceOf(SamTimeoutError);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
