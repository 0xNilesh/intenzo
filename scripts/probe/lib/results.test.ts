import { describe, expect, it } from "vitest";

import { mergeResults, ProbeResults, type ProbeResult } from "./results.ts";

const r = (model: ProbeResult["model"], capability: string, at: string): ProbeResult => ({
  model,
  capability,
  status: "ok",
  latencyMs: { p50: 1, samples: [1] },
  correct: null,
  at,
});

describe("mergeResults", () => {
  it("replaces results for the same model and capability, keeping the rest", () => {
    const merged = mergeResults(
      [r("wonder", "text", "old"), r("spark-1.3", "text", "old")],
      [r("wonder", "text", "new")],
    );
    expect(merged.map((x) => `${x.model}/${x.capability}@${x.at}`)).toEqual([
      "spark-1.3/text@old",
      "wonder/text@new",
    ]);
  });

  it("orders by model list, then capability", () => {
    const merged = mergeResults(
      [],
      [
        r("voice-transcribe", "file", "t"),
        r("spark-1.3", "video_inline", "t"),
        r("spark-1.3", "image", "t"),
      ],
    );
    expect(merged.map((x) => `${x.model}/${x.capability}`)).toEqual([
      "spark-1.3/image",
      "spark-1.3/video_inline",
      "voice-transcribe/file",
    ]);
  });
});

describe("ProbeResults schema", () => {
  it("rejects an unknown status", () => {
    const bad = { generatedAt: "t", results: [{ ...r("wonder", "text", "t"), status: "maybe" }] };
    expect(ProbeResults.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown model", () => {
    const bad = { generatedAt: "t", results: [{ ...r("wonder", "text", "t"), model: "gpt" }] };
    expect(ProbeResults.safeParse(bad).success).toBe(false);
  });
});
