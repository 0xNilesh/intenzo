// Contract: SAM 3.1 streaming as documented (Responses API, SSE, one frame line per
// response.output_text.delta), against a local fake server.
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { samStream } from "./sam.ts";

const BOX = "x1=620;y1=300;x2=819;y2=419;w=960;h=540";
let server: Server | undefined;

afterEach(() => {
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => resolve(raw));
  });
}

const sse = (res: ServerResponse, event: string, data: unknown) =>
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

describe("samStream", () => {
  it("posts a streaming request and collects one frame per delta event", async () => {
    let seen: Record<string, unknown> = {};
    const base = await serve(async (req, res) => {
      seen = {
        path: req.url,
        auth: req.headers.authorization,
        accept: req.headers.accept,
        body: JSON.parse(await readBody(req)),
      };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      sse(res, "response.created", {});
      sse(res, "response.output_text.delta", {
        delta: `<0f>1<|box;${BOX}|><|mask;x=0;y=0;data=120,200,~abc|>`,
      });
      sse(res, "response.output_text.delta", { delta: `<1f>1<|box;${BOX}|>` });
      sse(res, "response.completed", {});
      res.end();
    });

    const run = await samStream("test-key", { model: "sam-3.1", stream: true }, base);

    expect(seen).toMatchObject({
      path: "/v1/responses",
      auth: "Bearer test-key",
      accept: "text/event-stream",
      body: { model: "sam-3.1", stream: true },
    });
    expect("failure" in run).toBe(false);
    if ("failure" in run) return;
    expect(run.frames.map((f) => f.frame)).toEqual([0, 1]);
    expect(run.frames[0]?.objects[0]?.mask).toMatchObject({ h: 120, w: 200, encoding: "lossless" });
    expect(run.events).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.completed",
    ]);
    expect(run.firstDeltaMs).not.toBeNull();
  });

  it("completes normally with no frames when nothing matches", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      sse(res, "response.completed", {});
      res.end();
    });
    const run = await samStream("k", {}, base);
    expect("failure" in run ? run.failure : run.frames).toEqual([]);
  });

  it("returns the HTTP error for a rejected prompt", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":{"message":"invalid box token"}}');
    });
    const run = await samStream("k", {}, base);
    expect("failure" in run && run.failure.status).toBe(400);
    expect("failure" in run && run.failure.text).toContain("invalid box token");
  });

  it("treats an error event inside the stream as a failure", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      sse(res, "error", { message: "frame decode failed" });
      res.end();
    });
    const run = await samStream("k", {}, base);
    expect("failure" in run && run.failure.text).toContain("frame decode failed");
  });
});
