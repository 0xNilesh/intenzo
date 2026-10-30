import { describe, expect, it } from "vitest";

import {
  costUsd,
  extractJson,
  judgeSpecs,
  MAX_OUTPUT_TOKENS,
  parseJudgeOutput,
  requestBody,
  usageOf,
} from "./judge.ts";

const VALID = {
  verdict: "fail",
  targetCorrect: true,
  citedReadings: [2, 4],
  citedValue: "$50.00",
  atMs: 2023,
  observed: "The total stayed at $50.00 until the reload.",
};

describe("extractJson", () => {
  it.each([
    ["plain JSON", JSON.stringify(VALID)],
    ["a fenced block", "```json\n" + JSON.stringify(VALID) + "\n```"],
    ["prose around it", `Here is my verdict:\n${JSON.stringify(VALID)}\nThanks.`],
    ["a think block with braces", `<think>{"verdict": "pass"} hmm</think>${JSON.stringify(VALID)}`],
  ])("finds the object in %s", (_, text) => {
    expect(extractJson(text)).toEqual(VALID);
  });

  it("throws when there is no object", () => {
    expect(() => extractJson("I think it fails.")).toThrow("no JSON object");
  });
});

describe("parseJudgeOutput", () => {
  it("accepts a valid JudgeOutput", () => {
    expect(parseJudgeOutput(JSON.stringify(VALID))).toEqual({ ok: true, value: VALID });
  });

  it("names what's wrong, for the one retry (§14)", () => {
    const bad = parseJudgeOutput(JSON.stringify({ ...VALID, verdict: "maybe", atMs: undefined }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/verdict: .*; atMs: /);
    expect(parseJudgeOutput("no json")).toEqual({
      ok: false,
      error: "no JSON object in the reply",
    });
  });
});

describe("requestBody", () => {
  const [open, spark] = judgeSpecs();
  const media = { imageUrl: "data:image/png;base64,AA==", videoUrl: "data:video/mp4;base64,AA==" };

  it("sends both judges the same system prompt and bundle, video last", () => {
    for (const spec of [open, spark]) {
      const body = requestBody(spec, "BUNDLE", media);
      expect(body.messages.map((m) => m.role)).toEqual(["system", "user"]);
      const parts = body.messages[1]!.content as { type: string }[];
      expect(parts.map((p) => p.type)).toEqual(["text", "text", "image_url", "text", "video_url"]);
      expect(parts[0]).toEqual({ type: "text", text: "BUNDLE" });
    }
  });

  it("asks Spark 1.3 for strict JSON, and Spark Open (no structured outputs) only by prompt", () => {
    const b = requestBody(spark, "x", media);
    expect(b).toMatchObject({
      model: "muse-spark-1.3",
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      response_format: { type: "json_schema", json_schema: { strict: true } },
    });
    const a = requestBody(open, "x", media);
    expect(a).toMatchObject({ max_tokens: MAX_OUTPUT_TOKENS });
    expect(a).not.toHaveProperty("response_format");
  });

  it("sets reasoning_effort only when asked", () => {
    expect(requestBody(spark, "x", media)).not.toHaveProperty("reasoning_effort");
    expect(requestBody(spark, "x", media, "low")).toHaveProperty("reasoning_effort", "low");
  });
});

describe("usage and cost", () => {
  it("reads Meta usage details, and tolerates hosts without them", () => {
    const meta = {
      usage: {
        prompt_tokens: 4000,
        completion_tokens: 2000,
        prompt_tokens_details: { cached_tokens: 1000 },
        completion_tokens_details: { reasoning_tokens: 1800 },
      },
    };
    expect(usageOf(meta)).toEqual({
      promptTokens: 4000,
      cachedTokens: 1000,
      completionTokens: 2000,
      reasoningTokens: 1800,
    });
    expect(usageOf({ usage: { prompt_tokens: 10, completion_tokens: 5 } })).toEqual({
      promptTokens: 10,
      cachedTokens: 0,
      completionTokens: 5,
      reasoningTokens: 0,
    });
  });

  it("prices cached input, fresh input and output (reasoning bills as output)", () => {
    const usage = {
      promptTokens: 4000,
      cachedTokens: 1000,
      completionTokens: 2000,
      reasoningTokens: 1800,
    };
    // 3000 × $1.25 + 1000 × $0.15 + 2000 × $4.25, per million
    expect(costUsd(usage)).toBeCloseTo(0.0124, 6);
  });
});
