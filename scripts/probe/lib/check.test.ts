import { describe, expect, it } from "vitest";

import { checkResults } from "./check.ts";
import { MODELS, REQUIRED, type ModelKey, type ProbeResult } from "./results.ts";

const result = (
  model: ModelKey,
  capability: string,
  over: Partial<ProbeResult> = {},
): ProbeResult => ({
  model,
  capability,
  status: "ok",
  latencyMs: { p50: 100, samples: [100] },
  correct: true,
  at: "2026-10-29T00:00:00.000Z",
  ...over,
});

const complete = (): ProbeResult[] =>
  MODELS.flatMap((model) => REQUIRED[model].map((capability) => result(model, capability)));

describe("checkResults", () => {
  it("passes when every required capability has a definite answer", () => {
    expect(checkResults(complete())).toEqual([]);
  });

  it("accepts unsupported as a definite answer, with or without latency", () => {
    const results = complete().map((r) =>
      r.model === "muse-code" && r.capability === "api_model"
        ? { ...r, status: "unsupported" as const, latencyMs: null }
        : r,
    );
    expect(checkResults(results)).toEqual([]);
  });

  it("reports a required capability with no result", () => {
    const results = complete().filter(
      (r) => !(r.model === "wonder" && r.capability === "computer_use"),
    );
    expect(checkResults(results)).toEqual(["wonder/computer_use: no result yet"]);
  });

  it("treats error as no answer yet and includes the reason", () => {
    const results = complete().map((r) =>
      r.model === "spark-open" && r.capability === "video"
        ? { ...r, status: "error" as const, latencyMs: null, error: "BASETEN_API_KEY is not set" }
        : r,
    );
    expect(checkResults(results)).toEqual([
      "spark-open/video: no definite answer (BASETEN_API_KEY is not set)",
    ]);
  });

  it("requires a latency for ok results", () => {
    const results = complete().map((r) =>
      r.model === "sam-3.1" && r.capability === "video_box" ? { ...r, latencyMs: null } : r,
    );
    expect(checkResults(results)).toEqual(["sam-3.1/video_box: ok but no latency recorded"]);
  });

  it("reports every gap at once on an empty file", () => {
    const total = MODELS.reduce((n, model) => n + REQUIRED[model].length, 0);
    expect(checkResults([])).toHaveLength(total);
  });
});
