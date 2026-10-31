import { describe, expect, it } from "vitest";

import { transcribeCostUsd, transcribeWav } from "./transcribe.ts";

const WAV = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

/** A stand-in for fetch that keeps what it was sent and answers as told. */
function fakeFetch(status: number, body: unknown) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

describe("transcribeWav (dev.meta.ai/docs/api-reference/voice/transcribe)", () => {
  it("posts the WAV and its settings as multipart, and reads the transcript", async () => {
    const { fetch, sent } = fakeFetch(200, {
      sessionId: "voyager/transcribe/1",
      transcript: " apply SAVE10 ",
      audioDurationMs: 4640,
      turns: [],
    });
    const out = await transcribeWav({ apiKey: "k", wav: WAV, fetch });
    expect(out).toMatchObject({ text: "apply SAVE10", audioDurationMs: 4640 });
    expect(sent[0]!.url).toBe("https://api.meta.ai/v1/asr/transcribe");
    expect(sent[0]!.init.headers).toMatchObject({ Authorization: "Bearer k" });
    const form = sent[0]!.init.body as FormData;
    expect(JSON.parse(await (form.get("request") as Blob).text())).toEqual({
      model: "muse-voice-transcribe-1.0",
      audioEncoding: "WAV",
      mode: "PUSH_TO_TALK",
    });
    expect(new Uint8Array(await (form.get("audio") as Blob).arrayBuffer())).toEqual(WAV);
  });

  it("names the status when the endpoint refuses", async () => {
    const { fetch } = fakeFetch(401, "bad key");
    await expect(transcribeWav({ apiKey: "k", wav: WAV, fetch })).rejects.toThrow(
      "Voice Transcribe: HTTP 401: bad key",
    );
  });

  it("prices audio by whole seconds at $0.18 an hour", () => {
    expect(transcribeCostUsd(36_500)).toBeCloseTo((36 / 3600) * 0.18, 10);
  });
});
