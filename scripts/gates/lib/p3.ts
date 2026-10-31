// The Phase 3 gate's lane checks (ROADMAP P3 gate). The paths are the navigator's own, so their
// watch labels are its choice too; P1's label-by-label ground truth can't score them. These checks
// hold P1's facts instead (fixtures/ground-truth.json, DECISIONS 2026-10-30 · Seeded demo
// branches), whatever the labels: the almost-right PR shows the discount line, a stale $50.00
// total until a reload, the expired-code toast and the chart; main has no discount field.

import type { LaneResult, Reading } from "@intenzo/core";

export const P3_CRITERIA = ["C1", "C2", "C3", "C4"] as const;
const DISCOUNT_LINE = "Discount (SAVE10) −$5.00";
const EXPIRED = "+ alert: This code has expired";

const post = (lane: LaneResult) => lane.readings.filter((r) => r.phase === "post");
const valueHas = (r: Reading, text: string) => r.value?.includes(text) ?? false;

/** What's wrong with one lane of an explored path's replay; empty when it holds. */
export function p3LaneProblems(criterionId: string, lane: LaneResult): string[] {
  if (lane.side === "base") {
    // main has no discount codes: the replay must stop at the code field, after the PRE readings.
    const problems: string[] = [];
    if (lane.status !== "trigger_absent")
      problems.push(`base ended ${lane.status}, not trigger_absent`);
    if (!lane.readings.some((r) => r.phase === "pre")) problems.push("base took no PRE readings");
    return problems;
  }
  if (lane.status !== "completed") return [`pr ended ${lane.status}, not completed`];
  const readings = post(lane);
  const atEachOffset = (test: (r: Reading) => boolean) => {
    const offsets = new Set(
      readings.map((r) => r.tMs - (lane.tTriggerMs ?? 0)).map((ms) => Math.round(ms / 1000)),
    );
    return [...offsets].every((s) =>
      readings.some((r) => Math.round((r.tMs - (lane.tTriggerMs ?? 0)) / 1000) === s && test(r)),
    );
  };
  switch (criterionId) {
    case "C1":
      return atEachOffset((r) => valueHas(r, DISCOUNT_LINE))
        ? []
        : [`no POST reading shows "${DISCOUNT_LINE}" at every offset`];
    case "C2": {
      // The total: the element that read $50.00 before the trigger.
      const labels = lane.readings
        .filter((r) => r.phase === "pre" && r.kind === "text" && r.value === "$50.00")
        .map((r) => r.label);
      const holds = labels.some((label) => {
        const values = (phase: Reading["phase"]) =>
          lane.readings.filter((r) => r.label === label && r.phase === phase).map((r) => r.value);
        const after = values("after_reload");
        return (
          values("post").length >= 3 &&
          values("post").every((v) => v === "$50.00") &&
          after.length > 0 &&
          after.every((v) => v === "$45.00")
        );
      });
      return holds
        ? []
        : ["no total reads $50.00 at every POST offset and $45.00 after the reload"];
    }
    case "C3":
      return atEachOffset((r) => r.kind === "region_diff" && valueHas(r, EXPIRED))
        ? []
        : [`the toast ("${EXPIRED}") isn't read at every offset`];
    case "C4": {
      // A canvas has no text to read: the chart is reached when it's watched with a box, or when
      // a region's diff shows its legend gaining the discount slice.
      const chart = readings.some((r) => /chart/i.test(r.label) && r.bbox !== null);
      const legend = readings.some(
        (r) =>
          r.kind === "region_diff" &&
          /figure|img/.test(r.value ?? "") &&
          valueHas(r, "Discount (SAVE10)"),
      );
      return chart || legend
        ? []
        : ["the savings chart isn't watched and no region shows its discount slice"];
    }
    default:
      return [`no P3 check for ${criterionId}`];
  }
}

/** Wonder's list price per million tokens (dev.meta.ai/docs/pricing-rate-limits, 2026-10-31). */
export const WONDER_USD_PER_M = { input: 4, cached: 0.2, output: 20 } as const;

export function wonderCostUsd(usage: {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}): number {
  const fresh = usage.promptTokens - usage.cachedTokens;
  return (
    (fresh * WONDER_USD_PER_M.input +
      usage.cachedTokens * WONDER_USD_PER_M.cached +
      usage.completionTokens * WONDER_USD_PER_M.output) /
    1e6
  );
}
