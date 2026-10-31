import { z } from "zod";

import { META_BASE_URL } from "./meta.ts";

// Muse Voice Transcribe's file endpoint (dev.meta.ai/docs/api-reference/voice/transcribe): a
// multipart POST of a 16 kHz mono WAV and its settings, answered with the whole transcript. It
// returns no word or turn timings (T0.2), so where a criterion falls in a video comes from Spark
// watching it (§18). Billed by audio time: $0.18 an hour (pricing page, read 2026-10-31).

export const TRANSCRIBE_MODEL = "muse-voice-transcribe-1.0";
export const TRANSCRIBE_USD_PER_HOUR = 0.18;

const Reply = z.looseObject({
  transcript: z.string(),
  audioDurationMs: z.number().nonnegative().optional(),
});

export interface Transcript {
  text: string;
  audioDurationMs: number | null;
  /** Wall time of the call. */
  ms: number;
}

export interface TranscribeOptions {
  apiKey: string;
  /** 16 kHz mono 16-bit WAV bytes. */
  wav: Uint8Array<ArrayBuffer>;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export async function transcribeWav(options: TranscribeOptions): Promise<Transcript> {
  const started = performance.now();
  const form = new FormData();
  const settings = { model: TRANSCRIBE_MODEL, audioEncoding: "WAV", mode: "PUSH_TO_TALK" };
  form.append("request", new Blob([JSON.stringify(settings)], { type: "application/json" }));
  form.append("audio", new Blob([options.wav], { type: "audio/wav" }), "speech.wav");
  const res = await (options.fetch ?? fetch)(`${options.baseUrl ?? META_BASE_URL}/asr/transcribe`, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Voice Transcribe: HTTP ${res.status}: ${text.slice(0, 200)}`);
  const reply = Reply.parse(JSON.parse(text));
  return {
    text: reply.transcript.trim(),
    audioDurationMs: reply.audioDurationMs ?? null,
    ms: Math.round(performance.now() - started),
  };
}

/** The list-price cost of transcribing this much audio (metered in whole seconds). */
export const transcribeCostUsd = (audioMs: number) =>
  (Math.floor(audioMs / 1000) / 3600) * TRANSCRIBE_USD_PER_HOUR;
