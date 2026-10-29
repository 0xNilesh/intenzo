import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { metaKey } from "../lib/env.ts";
import { parseJson, request } from "../lib/http.ts";
import { allKeys, allStrings, asString, dig } from "../lib/json.ts";
import {
  capability,
  failed,
  fileBlob,
  missingKey,
  quote,
  sampled,
  succeeded,
  type Probe,
} from "../lib/probe.ts";
import { scoreTranscript } from "../lib/questions.ts";
import { REQUIRED } from "../lib/results.ts";
import { latency } from "../lib/stats.ts";
import { META_BASE, bearer } from "./meta-api.ts";

// Muse Voice Transcribe: a multipart WAV endpoint and a realtime WebSocket that authenticates in
// its first frame (dev.meta.ai/docs/api-reference/voice/transcribe, /realtime).
const MODEL = "muse-voice-transcribe-1.0";
const REALTIME_URL = "wss://api.meta.ai/v1/asr/realtime";
const FRAME_BYTES = 3840; // 80 ms of 24 kHz mono PCM16, as in the docs' example
const FRAME_MS = 80;
const REALTIME_SAMPLES = 3;
const TIMING_KEY = /^(start|end|offset|time|timestamp|startMs|endMs|words?)$/i;

type RealtimeRun =
  | {
      ok: true;
      totalMs: number;
      firstTranscriptMs: number | null;
      finalizeMs: number | null;
      transcript: string;
      eventTypes: string[];
      eventKeys: string[];
    }
  | { ok: false; error: string; eventTypes: string[] };

export const probeTranscribe: Probe = async (ctx) => {
  const key = metaKey();
  if (!key)
    return missingKey(ctx, "voice-transcribe", REQUIRED["voice-transcribe"], "META_API_KEY");

  await capability(ctx, "voice-transcribe", "file", async () => {
    const settings = { model: MODEL, audioEncoding: "WAV", mode: "PUSH_TO_TALK" };
    const call = () => {
      const form = new FormData();
      form.append("request", new Blob([JSON.stringify(settings)], { type: "application/json" }));
      form.append("audio", fileBlob(ctx.media.speechWav, "audio/wav"), "speech.wav");
      return request(`${META_BASE}/asr/transcribe`, {
        headers: { ...bearer(key), Accept: "application/json" },
        form,
      });
    };
    const run = await sampled(ctx.samples, call);
    if ("failure" in run) return failed(run.failure, { request: settings, audio: "<speech.wav>" });
    const strings = allStrings(run.last.body);
    const longest = strings.reduce((a, b) => (b.length > a.length ? b : a), "");
    const keys = allKeys(run.last.body);
    return succeeded(
      run,
      { request: settings, audio: "<speech.wav, 16 kHz mono>" },
      scoreTranscript(strings.join(" ")),
      `transcript: ${quote(longest)}; response keys: ${keys.join(", ")}; timing keys: ${keys.filter((k) => TIMING_KEY.test(k)).join(", ") || "none"}`,
    );
  });

  await capability(ctx, "voice-transcribe", "realtime", async () => {
    const pcm = new Uint8Array(readFileSync(ctx.media.speechPcm24k));
    const finalize: number[] = [];
    let last: Extract<RealtimeRun, { ok: true }> | undefined;
    for (let i = 0; i < Math.min(ctx.samples, REALTIME_SAMPLES); i++) {
      const run = await realtimeOnce(key, pcm);
      if (!run.ok) {
        return {
          status: "error",
          latencyMs: null,
          correct: null,
          error: run.error,
          notes: `events seen: ${run.eventTypes.join(", ") || "none"}`,
        };
      }
      if (run.finalizeMs !== null) finalize.push(run.finalizeMs);
      last = run;
    }
    const run = last!;
    return {
      status: "ok",
      // Latency that matters for a live PM note: endStream → last final transcript.
      latencyMs: latency(finalize.length > 0 ? finalize : [run.totalMs]),
      correct: scoreTranscript(run.transcript),
      request: {
        handshake: {
          authorization: "<redacted>",
          audioEncoding: "PCM_24KHZ",
          model: MODEL,
          mode: "PUSH_TO_TALK",
        },
        audio: `binary ${FRAME_BYTES}-byte frames every ${FRAME_MS} ms, then {"type":"endStream"}`,
      },
      response: { eventTypes: run.eventTypes, eventKeys: run.eventKeys },
      notes: [
        finalize.length > 0
          ? "p50 = endStream → last final transcript"
          : "p50 = whole session (no final transcript timing)",
        run.firstTranscriptMs !== null
          ? `first transcript event after ${Math.round(run.firstTranscriptMs)} ms`
          : "no transcript events",
        `session ${Math.round(run.totalMs)} ms for ${((pcm.length / 48_000) * 1000).toFixed(0)} ms of audio`,
        `timing keys: ${run.eventKeys.filter((k) => TIMING_KEY.test(k)).join(", ") || "none"}`,
        `transcript: ${quote(run.transcript)}`,
      ].join("; "),
    };
  });
};

/** One realtime session: handshake, audio at real-time pace, endStream, read until close. */
export function realtimeOnce(
  key: string,
  pcm: Uint8Array,
  url: string = REALTIME_URL,
): Promise<RealtimeRun> {
  return new Promise((resolve) => {
    const started = performance.now();
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const types = new Set<string>();
    const keys = new Set<string>();
    const finals: string[] = [];
    let acked = false;
    let error: string | undefined;
    let firstTranscriptMs: number | null = null;
    let endSentAt: number | null = null;
    let lastFinalAt: number | null = null;
    const timeout = setTimeout(() => {
      error ??= "timed out after 60 s";
      ws.close();
    }, 60_000);

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          authorization: { accessToken: `Bearer ${key}` },
          audioEncoding: "PCM_24KHZ",
          model: MODEL,
          mode: "PUSH_TO_TALK",
        }),
      );
    });

    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return; // binary frames carry nothing we need
      const message = parseJson(event.data);
      for (const k of allKeys(message)) keys.add(k);
      const type = asString(dig(message, "type"));
      types.add(type || "(handshake ack)");
      if (type === "error") {
        error = asString(dig(message, "message")) || event.data;
      } else if (!acked) {
        if (dig(message, "sessionId") !== undefined) {
          acked = true;
          void streamAudio();
        }
      } else if (type === "transcript") {
        firstTranscriptMs ??= performance.now() - started;
        if (dig(message, "final") === true) {
          finals.push(asString(dig(message, "transcript")));
          lastFinalAt = performance.now();
        }
      }
    });

    ws.addEventListener("error", () => {
      error ??= "websocket error";
    });

    ws.addEventListener("close", (event) => {
      clearTimeout(timeout);
      const eventTypes = [...types];
      if (error !== undefined || event.code !== 1000) {
        resolve({
          ok: false,
          error:
            error ?? `closed with code ${event.code}${event.reason ? ` (${event.reason})` : ""}`,
          eventTypes,
        });
        return;
      }
      resolve({
        ok: true,
        totalMs: performance.now() - started,
        firstTranscriptMs,
        finalizeMs:
          endSentAt !== null && lastFinalAt !== null ? Math.max(0, lastFinalAt - endSentAt) : null,
        transcript: finals.join(" ").trim(),
        eventTypes,
        eventKeys: [...keys],
      });
    });

    // Real-time pace against an absolute clock, so timer drift never makes us fall behind.
    async function streamAudio(): Promise<void> {
      const t0 = performance.now();
      for (let i = 0, offset = 0; offset < pcm.length; i++, offset += FRAME_BYTES) {
        await sleep(Math.max(0, t0 + i * FRAME_MS - performance.now()));
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(pcm.subarray(offset, offset + FRAME_BYTES));
      }
      endSentAt = performance.now();
      ws.send(JSON.stringify({ type: "endStream" }));
    }
  });
}
