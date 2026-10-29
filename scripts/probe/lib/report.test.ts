import { describe, expect, it } from "vitest";

import { formatResult } from "./report.ts";
import type { ProbeResult } from "./results.ts";

const base: ProbeResult = {
  model: "spark-1.3",
  capability: "video_inline",
  status: "ok",
  latencyMs: { p50: 4210, samples: [4210] },
  correct: true,
  notes: 'answer: "start=50, end=45"',
  at: "t",
};

describe("formatResult", () => {
  it("shows status, p50, correctness and notes", () => {
    expect(formatResult(base)).toBe(
      '✓ spark-1.3/video_inline  ·  ok  ·  p50 4210 ms  ·  answer correct  ·  answer: "start=50, end=45"',
    );
  });

  it("flags a wrong answer", () => {
    expect(formatResult({ ...base, correct: false })).toContain("answer WRONG");
  });

  it("shows the error instead of notes, and omits what isn't known", () => {
    const line = formatResult({
      ...base,
      status: "error",
      latencyMs: null,
      correct: null,
      error: "META_API_KEY is not set",
    });
    expect(line).toBe("✗ spark-1.3/video_inline  ·  error  ·  META_API_KEY is not set");
  });

  it("marks unsupported capabilities", () => {
    expect(formatResult({ ...base, status: "unsupported", correct: null })).toMatch(/^∅ /);
  });
});
