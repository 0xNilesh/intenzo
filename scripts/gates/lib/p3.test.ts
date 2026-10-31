import { LaneResult, type Reading } from "@intenzo/core";
import { describe, expect, it } from "vitest";

import { p3LaneProblems, wonderCostUsd } from "./p3.ts";

const TT = 10_000;
const r = (
  label: string,
  phase: Reading["phase"],
  atS: number,
  kind: Reading["kind"],
  value: string | null,
  bbox = false,
): Reading => ({
  i: 0,
  label,
  phase,
  tMs: TT + atS * 1000,
  kind,
  value,
  bbox: bbox ? [0, 0, 10, 10] : null,
});

function lane(side: "pr" | "base", status: LaneResult["status"], readings: Reading[]): LaneResult {
  return LaneResult.parse({
    criterionId: "C1",
    side,
    status,
    laneStartMs: 0,
    tTriggerMs: status === "completed" ? TT : null,
    stepLog:
      status === "completed"
        ? [
            {
              tMs: TT,
              step: { op: "click", target: { by: "testId", id: "apply" } },
              ok: true,
              trigger: true,
            },
          ]
        : [],
    readings: readings.map((x, i) => ({ ...x, i })),
    consoleErrorCount: 0,
    failedRequestCount: 0,
    isolation: "ephemeral_user",
  });
}

const posts = (label: string, kind: Reading["kind"], value: string | null, bbox = false) =>
  [0, 1, 3].map((s) => r(label, "post", s, kind, value, bbox));

describe("p3LaneProblems", () => {
  it("C1: the discount line at every POST offset, under any label", () => {
    expect(
      p3LaneProblems(
        "C1",
        lane(
          "pr",
          "completed",
          posts("Discount code", "region_diff", "+ listitem: Discount (SAVE10) −$5.00"),
        ),
      ),
    ).toEqual([]);
    expect(
      p3LaneProblems("C1", lane("pr", "completed", [...posts("x", "text", "nothing")])),
    ).toHaveLength(1);
  });

  it("C2: the total stale at $50.00 after the trigger and $45.00 after the reload", () => {
    const stale = [
      r("order total", "pre", -1, "text", "$50.00"),
      ...posts("order total", "text", "$50.00"),
      r("order total", "after_reload", 4, "text", "$45.00"),
    ];
    expect(p3LaneProblems("C2", lane("pr", "completed", stale))).toEqual([]);
    const fixed = [
      r("total", "pre", -1, "text", "$50.00"),
      ...posts("total", "text", "$45.00"),
      r("total", "after_reload", 4, "text", "$45.00"),
    ];
    expect(p3LaneProblems("C2", lane("pr", "completed", fixed))).toHaveLength(1);
  });

  it("C3: the expired-code toast through the live regions", () => {
    expect(
      p3LaneProblems(
        "C3",
        lane(
          "pr",
          "completed",
          posts("live regions", "region_diff", "+ alert: This code has expired"),
        ),
      ),
    ).toEqual([]);
    expect(
      p3LaneProblems(
        "C3",
        lane("pr", "completed", posts("live regions", "region_diff", "no change")),
      ),
    ).toHaveLength(1);
  });

  it("C4: the chart watched with a box, or the legend gaining the discount", () => {
    expect(
      p3LaneProblems("C4", lane("pr", "completed", posts("savings chart", "text", "", true))),
    ).toEqual([]);
    expect(
      p3LaneProblems(
        "C4",
        lane(
          "pr",
          "completed",
          posts("summary", "region_diff", '+ figure "Savings: Discount (SAVE10) −$5.00"'),
        ),
      ),
    ).toEqual([]);
    expect(
      p3LaneProblems("C4", lane("pr", "completed", posts("summary", "region_diff", "no change"))),
    ).toHaveLength(1);
  });

  it("base: the replay stops at the missing code field, after the PRE readings", () => {
    expect(
      p3LaneProblems(
        "C2",
        lane("base", "trigger_absent", [r("order total", "pre", -1, "text", "$50.00")]),
      ),
    ).toEqual([]);
    expect(
      p3LaneProblems(
        "C2",
        lane("base", "completed", [r("order total", "pre", -1, "text", "$50.00")]),
      ),
    ).toEqual(["base ended completed, not trigger_absent"]);
  });

  it("a PR lane that didn't complete fails", () => {
    expect(p3LaneProblems("C2", lane("pr", "setup_failed", []))).toEqual([
      "pr ended setup_failed, not completed",
    ]);
  });
});

describe("wonderCostUsd", () => {
  it("prices fresh input, cached input and output", () => {
    expect(
      wonderCostUsd({ promptTokens: 2595, cachedTokens: 2024, completionTokens: 466 }),
    ).toBeCloseTo(0.0120088, 7);
  });
});
