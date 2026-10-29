import { describe, expect, it } from "vitest";

import { parseSse, parseSseBlock, readSse } from "./sse.ts";

const enc = new TextEncoder();

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield enc.encode(part);
}

async function collect(body: AsyncIterable<Uint8Array>) {
  const out = [];
  for await (const event of readSse(body)) out.push(event);
  return out;
}

describe("parseSseBlock", () => {
  it("reads event name and data", () => {
    expect(parseSseBlock('event: response.output_text.delta\ndata: {"delta":"<0f>"}')).toEqual({
      event: "response.output_text.delta",
      data: '{"delta":"<0f>"}',
    });
  });

  it("joins multi-line data, ignores comments and defaults the event name", () => {
    expect(parseSseBlock(": keep-alive\ndata: a\ndata: b")).toEqual({
      event: "message",
      data: "a\nb",
    });
  });

  it("returns null for a comment-only block", () => {
    expect(parseSseBlock(": ping")).toBeNull();
  });
});

describe("parseSse", () => {
  it("splits on blank lines, including CRLF", () => {
    const events = parseSse("event: a\r\ndata: 1\r\n\r\nevent: b\ndata: 2\n\n");
    expect(events.map((e) => `${e.event}=${e.data}`)).toEqual(["a=1", "b=2"]);
  });
});

describe("readSse", () => {
  it("reassembles events split across chunk boundaries", async () => {
    const events = await collect(
      chunks(
        "event: response.output_text.de",
        'lta\ndata: {"delta":1}\n',
        "\nevent: response.completed\ndata: {}\n\n",
      ),
    );
    expect(events).toEqual([
      { event: "response.output_text.delta", data: '{"delta":1}' },
      { event: "response.completed", data: "{}" },
    ]);
  });

  it("emits a final event that has no trailing blank line", async () => {
    expect(await collect(chunks("data: last"))).toEqual([{ event: "message", data: "last" }]);
  });

  it("decodes multi-byte characters split across chunks", async () => {
    const bytes = enc.encode("data: ✓\n\n");
    async function* split() {
      yield bytes.slice(0, 7);
      yield bytes.slice(7);
    }
    expect(await collect(split())).toEqual([{ event: "message", data: "✓" }]);
  });
});
