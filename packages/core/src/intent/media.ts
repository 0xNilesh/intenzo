import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ffmpegAsync } from "../browser/ffmpeg.ts";
import { transcribeWav, type Transcript } from "../models/transcribe.ts";

// A PM's screen recording, made ready for the intent step (§18): its speech as a transcript
// (Voice Transcribe, from a 16 kHz mono WAV) and its picture as a small MP4 for Spark 1.3 (2 fps,
// 960 px wide), sent inline as a data URL. ffmpeg only decodes and encodes (§21.4).

export interface TicketVideo {
  transcript: Transcript;
  /** data:video/mp4;base64,… for Spark's video_url part. */
  dataUrl: string;
  /** The intent MP4's size, which drives the prompt's video tokens. */
  bytes: number;
  /** sha256 of the original recording: part of the ticket hash. */
  mediaHash: string;
}

export async function prepareTicketVideo(
  video: string,
  options: { apiKey: string; fetch?: typeof fetch },
): Promise<TicketVideo> {
  const work = mkdtempSync(join(tmpdir(), "intenzo-intent-"));
  try {
    const wav = join(work, "speech.wav");
    const mp4 = join(work, "intent.mp4");
    await Promise.all([
      ffmpegAsync("-i", video, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav),
      ffmpegAsync(
        "-i",
        video,
        "-an",
        "-vf",
        "fps=2,scale=960:-2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        mp4,
      ),
    ]);
    const transcript = await transcribeWav({
      apiKey: options.apiKey,
      wav: readFileSync(wav),
      ...(options.fetch && { fetch: options.fetch }),
    });
    const encoded = readFileSync(mp4);
    return {
      transcript,
      dataUrl: `data:video/mp4;base64,${encoded.toString("base64")}`,
      bytes: encoded.length,
      mediaHash: createHash("sha256").update(readFileSync(video)).digest("hex"),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
