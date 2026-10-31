import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { metaModelPort } from "../models/meta.ts";
import { costUsd } from "../models/pricing.ts";
import { transcribeCostUsd } from "../models/transcribe.ts";
import { CriterionSet } from "../schema/index.ts";
import { extractIntent } from "./intent.ts";
import { prepareTicketVideo } from "./media.ts";

// T4.2, by hand only (`pnpm --filter @intenzo/core exec vitest run --project live intent`): the
// demo ticket (demo-shop #5) with its PM recording, read by Voice Transcribe and Spark 1.3. One
// transcription (about 36 s of audio, under a cent) and one Spark call with the video (a few
// cents). Needs META_API_KEY in .env, ffmpeg, and the recording at probes/demo/pm-ticket.mp4
// (`pnpm demo:pm-video`). demo/README.md has when each criterion is said.

const REPO = resolve(import.meta.dirname, "../../../..");
if (existsSync(resolve(REPO, ".env"))) process.loadEnvFile(resolve(REPO, ".env"));
const KEY = process.env.META_API_KEY ?? process.env.MODEL_API_KEY;
const VIDEO = resolve(REPO, "probes/demo/pm-ticket.mp4");

/** What each demo criterion is about, and when the PM says it (demo/README.md). */
const DEMO = [
  { id: "C1", about: /line|−\$?5|-\$?5|minus five/i, saidAt: 18_500 },
  { id: "C2", about: /45/, saidAt: 9_400 },
  { id: "C3", about: /expired/i, saidAt: 24_400 },
  { id: "C4", about: /chart/i, saidAt: 30_000 },
];

describe.skipIf(!KEY || !existsSync(VIDEO))("intent from the PM's recording (live)", () => {
  it("finds C1–C4, each with a quote and its time in the video, starting at /cart", async () => {
    const [first, ...rest] = readFileSync(resolve(REPO, "fixtures/tickets/5.md"), "utf8").split(
      "\n",
    );
    const ticket = {
      ref: "#5",
      title: first!.replace(/^#\s*/, ""),
      body: rest.join("\n"),
      comments: [],
    };
    const video = await prepareTicketVideo(VIDEO, { apiKey: KEY! });
    console.log(`transcript (${video.transcript.ms} ms): ${video.transcript.text}`);
    expect(video.transcript.text).toMatch(/save ?10/i); // spoken "SAVE10" is written "save 10"

    const result = await extractIntent(metaModelPort({ apiKey: KEY! }), ticket, {
      transcript: video.transcript.text,
      video: {
        dataUrl: video.dataUrl,
        ...(video.transcript.audioDurationMs && { durationMs: video.transcript.audioDurationMs }),
      },
      mediaHashes: [video.mediaHash],
      timeoutMs: 180_000,
    });
    const spend =
      (costUsd("muse-spark-1.3", result.usage) ?? 0) +
      transcribeCostUsd(video.transcript.audioDurationMs ?? 0);
    console.log(
      `${result.calls} call(s), ${result.usage.promptTokens} in / ${result.usage.completionTokens} out, $${spend.toFixed(4)}`,
    );
    for (const c of result.intent.criteria) {
      console.log(
        `${c.id} @${c.sourceMediaAt ?? "?"} ms [${c.kind}] ${c.text} | "${c.sourceQuote ?? ""}"`,
      );
    }
    expect(result.problems).toEqual([]);
    const intent = CriterionSet.parse(result.intent);
    expect(intent.intentSource).toBe("linked_issue_video");
    expect(intent.repro?.startPath).toBe("/cart");
    expect(intent.criteria).toHaveLength(4);
    const duration = video.transcript.audioDurationMs ?? 40_000;
    const found = DEMO.map((want) => {
      const c = intent.criteria.find((c) => want.about.test(`${c.text} ${c.expected}`));
      expect(c, `a criterion about ${want.about}`).toBeDefined();
      expect(c!.sourceQuote).toBeTruthy();
      expect(c!.sourceMediaAt).toBeGreaterThanOrEqual(0);
      expect(c!.sourceMediaAt).toBeLessThanOrEqual(duration);
      console.log(`${want.id}: said at ${want.saidAt} ms, placed at ${c!.sourceMediaAt} ms`);
      return { said: want.saidAt, at: c!.sourceMediaAt! };
    });
    // Spark places them from the picture alone (the transcript has no timings): in the PM's
    // order, though seconds off (DECISIONS 2026-10-31 · Intent from the PM video).
    const bySaid = [...found].sort((a, b) => a.said - b.said).map((f) => f.at);
    expect(bySaid).toEqual([...bySaid].sort((a, b) => a - b));
  }, 240_000);
});
