import type { Reading } from "@intenzo/core";
import { describe, expect, it } from "vitest";

import { compareLane, ExpectedReading, type RecordedLane, type SideTruth } from "./p1.ts";

const OFFSETS = [0, 1000, 3000];
const TT = 1_000_000;

const truth: SideTruth = {
  status: "completed",
  readings: [
    { label: "order total", phase: "pre", kind: "text", value: "$50.00", bbox: true },
    { label: "order total", phase: "post", atMs: OFFSETS, kind: "text", value: "$50.00" },
    { label: "order total", phase: "after_reload", kind: "text", value: "$45.00" },
    {
      label: "live regions",
      phase: "post",
      atMs: [0, 1000, 3000],
      kind: "region_diff",
      includes: ["+ alert: This code has expired"],
    },
  ],
};

let i = 0;
const reading = (
  label: string,
  phase: Reading["phase"],
  atMs: number,
  kind: Reading["kind"],
  value: string | null,
  bbox: Reading["bbox"] = null,
): Reading => ({ i: i++, label, phase, kind, value, bbox, tMs: TT + atMs });

/** A lane that matches `truth`, readings taken a few ms into each window. */
function matchingLane(): RecordedLane & { readings: Reading[] } {
  return {
    status: "completed",
    tTriggerMs: TT,
    readings: [
      reading("order total", "pre", -100, "text", "$50.00", [10, 20, 30, 40]),
      ...OFFSETS.flatMap((at) => [
        reading("order total", "post", at + 2, "text", "$50.00"),
        reading("live regions", "post", at + 9, "region_diff", "+ alert: This code has expired"),
      ]),
      reading("order total", "after_reload", 3900, "text", "$45.00"),
    ],
  };
}

describe("compareLane", () => {
  it("accepts a lane that reads exactly the ground truth", () => {
    expect(compareLane(truth, matchingLane(), OFFSETS)).toEqual([]);
  });

  it("names a POST value by its offset: the stale total at +1 s", () => {
    const lane = matchingLane();
    lane.readings[3] = { ...lane.readings[3]!, value: "$45.00" };
    expect(compareLane(truth, lane, OFFSETS)).toEqual([
      'order total · post +1000 ms: expected "$50.00", got "$45.00"',
    ]);
  });

  it("needs every listed line in a diff, and the right kind", () => {
    const lane = matchingLane();
    lane.readings[2] = { ...lane.readings[2]!, value: "no change" };
    lane.readings[7] = { ...lane.readings[7]!, kind: "absent", value: null };
    expect(compareLane(truth, lane, OFFSETS)).toEqual([
      "order total · after_reload: expected kind text, got absent null",
      'live regions · post +0 ms: no line "+ alert: This code has expired"',
    ]);
  });

  it("reports missing and unexpected readings, and a wrong status", () => {
    const lane = matchingLane();
    lane.status = "trigger_absent";
    lane.readings.splice(7, 1); // the after_reload reading
    lane.readings.push(reading("discount line", "pre", -90, "absent", null));
    expect(compareLane(truth, lane, OFFSETS)).toEqual([
      "status: expected completed, got trigger_absent",
      "order total · after_reload: missing",
      "discount line · pre: unexpected reading null",
    ]);
  });

  it("treats a fourth POST reading as extra", () => {
    const lane = matchingLane();
    lane.readings.push(reading("order total", "post", 3500, "text", "$50.00"));
    expect(compareLane(truth, lane, OFFSETS)).toEqual([
      'order total · post #4: unexpected reading "$50.00"',
    ]);
  });

  it("rejects a POST reading taken before its offset or after the next one", () => {
    const lane = matchingLane();
    lane.readings[3] = { ...lane.readings[3]!, tMs: TT + 990 };
    lane.readings[1] = { ...lane.readings[1]!, tMs: TT + 1000 };
    expect(compareLane(truth, lane, OFFSETS)).toEqual([
      "order total · post +0 ms: read at Tt+1000 ms, outside its window",
      "order total · post +1000 ms: read at Tt+990 ms, outside its window",
    ]);
  });

  it("checks whether a bbox is there", () => {
    const lane = matchingLane();
    lane.readings[0] = { ...lane.readings[0]!, bbox: null };
    expect(compareLane(truth, lane, OFFSETS)).toEqual([
      "order total · pre: expected a bbox, got none",
    ]);
  });
});

describe("ExpectedReading", () => {
  const ok = (r: unknown) => ExpectedReading.safeParse(r).success;

  it("needs atMs on POST readings and nowhere else", () => {
    expect(ok({ label: "x", phase: "post", kind: "text", value: "" })).toBe(false);
    expect(ok({ label: "x", phase: "pre", atMs: [0], kind: "text", value: "" })).toBe(false);
    expect(ok({ label: "x", phase: "post", atMs: [0], kind: "text", value: "" })).toBe(true);
  });

  it("gives an absent reading no value, and any other reading a value or lines", () => {
    expect(ok({ label: "x", phase: "pre", kind: "absent" })).toBe(true);
    expect(ok({ label: "x", phase: "pre", kind: "absent", value: "" })).toBe(false);
    expect(ok({ label: "x", phase: "pre", kind: "text" })).toBe(false);
    expect(ok({ label: "x", phase: "pre", kind: "text", value: "a", includes: ["a"] })).toBe(false);
  });

  it("rejects unknown keys, so a typo can't silently skip a check", () => {
    expect(ok({ label: "x", phase: "pre", kind: "text", vaule: "a", value: "a" })).toBe(false);
  });
});
