// Contract: the realtime transcription protocol as documented (handshake frame with the
// credential, binary PCM frames at real-time pace, {"type":"endStream"}, read until close 1000),
// against a local fake server.
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type RawData, type WebSocket as ServerSocket } from "ws";

import { realtimeOnce } from "./transcribe.ts";

let wss: WebSocketServer | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
  wss = undefined;
});

async function fakeAsr(onSession: (socket: ServerSocket) => void): Promise<string> {
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  wss.on("connection", onSession);
  return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/v1/asr/realtime`;
}

describe("realtimeOnce", () => {
  it("handshakes first, streams binary frames, ends with endStream and reads the final transcript", async () => {
    let handshake: unknown;
    const frames: number[] = [];
    const textAfterHandshake: string[] = [];
    const url = await fakeAsr((socket) => {
      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) {
          frames.push((data as Buffer).length);
          return;
        }
        const text = data.toString();
        if (handshake === undefined) {
          handshake = JSON.parse(text);
          socket.send(JSON.stringify({ sessionId: "s1" }));
          return;
        }
        textAfterHandshake.push(text);
        if (JSON.parse(text).type === "endStream") {
          socket.send(
            JSON.stringify({ type: "transcript", transcript: "drop to forty", final: false }),
          );
          socket.send(
            JSON.stringify({
              type: "transcript",
              transcript: "The order total should drop to forty five dollars.",
              final: true,
            }),
          );
          socket.close(1000);
        }
      });
    });

    const pcm = new Uint8Array(3840 * 3 + 100); // three full 80 ms frames and a short tail
    const run = await realtimeOnce("test-key", pcm, url);

    expect(handshake).toEqual({
      authorization: { accessToken: "Bearer test-key" },
      audioEncoding: "PCM_24KHZ",
      model: "muse-voice-transcribe-1.0",
      mode: "PUSH_TO_TALK",
    });
    expect(frames).toEqual([3840, 3840, 3840, 100]);
    expect(textAfterHandshake).toEqual(['{"type":"endStream"}']);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.transcript).toBe("The order total should drop to forty five dollars.");
    expect(run.finalizeMs).not.toBeNull();
    expect(run.eventTypes).toEqual(["(handshake ack)", "transcript"]);
  });

  it("paces audio at roughly real time", async () => {
    const url = await fakeAsr((socket) => {
      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) return;
        const msg = JSON.parse(data.toString());
        if (msg.type === "endStream") socket.close(1000);
        else socket.send(JSON.stringify({ sessionId: "s1" }));
      });
    });
    const started = performance.now();
    await realtimeOnce("k", new Uint8Array(3840 * 5), url); // 400 ms of audio
    expect(performance.now() - started).toBeGreaterThanOrEqual(300);
  });

  it("reports a server error event and a policy close", async () => {
    const url = await fakeAsr((socket) => {
      socket.on("message", () => {
        socket.send(JSON.stringify({ type: "error", message: "invalid api key" }));
        socket.close(1008, "policy");
      });
    });
    const run = await realtimeOnce("bad", new Uint8Array(3840), url);
    expect(run).toMatchObject({ ok: false, error: "invalid api key" });
  });

  it("reports a close without an error event by its code", async () => {
    const url = await fakeAsr((socket) =>
      socket.on("message", () => socket.close(1013, "rate limited")),
    );
    const run = await realtimeOnce("k", new Uint8Array(3840), url);
    expect(run).toMatchObject({ ok: false, error: "closed with code 1013 (rate limited)" });
  });
});
