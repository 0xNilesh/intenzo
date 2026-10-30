import { describe, expect, it } from "vitest";

import type { Label } from "../clips.ts";
import { decide, latencyOf, score, type Metrics, type ScoredClip } from "./score.ts";
import type { VerdictValue } from "./schema.ts";

const clip = (label: Label, verdict: VerdictValue, verdictMs = 10_000): ScoredClip => ({
  label,
  verdict,
  verdictMs,
});

// 4 correct, 4 almost-right, 2 ambiguous, like the real clip set.
const RUN: ScoredClip[] = [
  clip("pass", "pass", 8_000),
  clip("pass", "pass", 9_000),
  clip("pass", "pass", 12_000),
  clip("pass", "inconclusive", 20_000),
  clip("fail", "fail", 10_000),
  clip("fail", "fail", 11_000),
  clip("fail", "pass", 7_000),
  clip("fail", "fail", 9_500),
  clip("ambiguous", "fail", 30_000),
  clip("ambiguous", "inconclusive", 15_000),
];

describe("score", () => {
  const m = score(RUN);

  it("builds the label × verdict confusion matrix", () => {
    expect(m.confusion).toEqual({
      pass: { pass: 3, fail: 0, inconclusive: 1 },
      fail: { pass: 1, fail: 3, inconclusive: 0 },
      ambiguous: { pass: 0, fail: 1, inconclusive: 1 },
    });
  });

  it("scores accuracy on decided clear clips only (no inconclusive, no ambiguous)", () => {
    expect([m.clear, m.decided, m.correct]).toEqual([8, 7, 6]);
    expect(m.accuracy).toBeCloseTo(6 / 7);
  });

  it("counts false fails, false passes and the inconclusive rate on clear clips", () => {
    expect([m.falseFails, m.falsePasses, m.inconclusive]).toEqual([0, 1, 1]);
    expect(m.inconclusiveRate).toBe(1 / 8);
  });

  it("summarizes time to verdict over every clip", () => {
    expect(m.verdictMs).toEqual({ p50: 10_500, max: 30_000 });
    expect(latencyOf([])).toBeNull();
  });

  it("has no accuracy or rate when there is nothing to score", () => {
    const empty = score([clip("ambiguous", "pass")]);
    expect([empty.accuracy, empty.inconclusiveRate]).toEqual([null, null]);
  });
});

describe("decide (ROADMAP T0.3 GO rule)", () => {
  const base: Metrics = score(RUN.filter((c) => c.verdict !== "pass" || c.label === "pass"));

  it("is GO when every threshold holds", () => {
    const { go, checks } = decide(base);
    expect(checks.map((c) => c.ok)).toEqual([true, true, true, true]);
    expect(go).toBe(true);
  });

  it.each<[string, Partial<Metrics>]>([
    ["accuracy below 80%", { correct: 3, decided: 4, accuracy: 0.75 }],
    ["nothing decided", { correct: 0, decided: 0, accuracy: null }],
    ["one false fail", { falseFails: 1 }],
    ["inconclusive above 30%", { inconclusive: 3, clear: 8, inconclusiveRate: 3 / 8 }],
    ["a verdict at 60 s", { verdictMs: { p50: 10_000, max: 60_000 } }],
  ])("is NO-GO with %s", (_, over) => {
    expect(decide({ ...base, ...over }).go).toBe(false);
  });

  it.each<[string, Partial<Metrics>]>([
    ["accuracy of exactly 80%", { correct: 4, decided: 5, accuracy: 0.8 }],
    ["inconclusive of exactly 30%", { inconclusive: 3, clear: 10, inconclusiveRate: 0.3 }],
  ])("is still GO at the boundary: %s", (_, over) => {
    expect(decide({ ...base, ...over }).go).toBe(true);
  });

  it("explains each check", () => {
    expect(decide(base).checks.map((c) => `${c.name}: ${c.detail}`)).toEqual([
      "accuracy on decided clips: 6/6 = 100% (need ≥ 80%)",
      "false fails on correct clips: 0 (need 0)",
      "inconclusive on clear clips: 1/7 = 14.3% (need ≤ 30%)",
      "time to verdict: p50 11.0 s, slowest 30.0 s (need < 60.0 s)", // 9 clips, median 11 s
    ]);
  });
});
