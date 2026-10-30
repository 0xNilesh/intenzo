import { describe, expect, it } from "vitest";

import { LaneResult, Reading, StepLogEntry } from "./lane.ts";
import { issues } from "./test-helpers.ts";

const T0 = 1_793_000_000_000;
const video = {
  store: "private",
  path: "runs/r1/C2/pr/take-1/video.mp4",
  contentType: "video/mp4",
};

const reading = (i: number, phase: "pre" | "post" | "after_reload", value: string | null) => ({
  i,
  label: "order total",
  kind: value === null ? "absent" : "text",
  phase,
  tMs: T0 + 1000 + i * 1000,
  value,
  bbox: value === null ? null : [742, 210, 96, 28],
});

// The almost-right PR's C2 lane: the total stays $50.00 until the reload.
const lane = {
  criterionId: "C2",
  side: "pr",
  status: "completed",
  laneStartMs: T0,
  tTriggerMs: T0 + 3200,
  humanVideo: video,
  judgeVideo: { ...video, path: "runs/r1/C2/pr/take-1/judge.mp4" },
  stepLog: [
    { tMs: T0 + 400, step: { op: "goto", path: "/cart" }, ok: true },
    {
      tMs: T0 + 2100,
      step: { op: "fill", target: { by: "label", text: "Discount code" }, value: "SAVE10" },
      ok: true,
    },
    {
      tMs: T0 + 3200,
      step: { op: "click", target: { by: "role", role: "button", name: "Apply" } },
      ok: true,
      trigger: true,
    },
    { tMs: T0 + 6400, step: { op: "reload" }, ok: true },
  ],
  readings: [
    reading(0, "pre", "$50.00"),
    reading(1, "post", "$50.00"),
    reading(2, "post", "$50.00"),
    reading(3, "after_reload", "$45.00"),
  ],
  consoleErrorCount: 0,
  failedRequestCount: 0,
  isolation: "ephemeral_user",
  videoOffsets: { human: -120, judge: -620 },
};

describe("Reading", () => {
  it("parses text, region-diff and absent readings", () => {
    expect(Reading.parse(reading(0, "pre", "$50.00")).value).toBe("$50.00");
    const diff = { ...reading(1, "post", '+ alert "This code has expired"'), kind: "region_diff" };
    expect(Reading.parse(diff).kind).toBe("region_diff");
    expect(Reading.parse(reading(2, "post", null)).kind).toBe("absent");
  });

  it("ties absent to a null value, both ways", () => {
    expect(issues(Reading, { ...reading(0, "pre", "$50.00"), kind: "absent" })).toEqual([
      "value: absent readings have no value, and only absent ones",
    ]);
    expect(issues(Reading, { ...reading(0, "pre", null), kind: "text" })).toEqual([
      "value: absent readings have no value, and only absent ones",
    ]);
  });
});

describe("StepLogEntry", () => {
  it("defaults trigger to false and logs the recorder's reload", () => {
    const entry = StepLogEntry.parse({ tMs: T0, step: { op: "reload" }, ok: true });
    expect(entry.trigger).toBe(false);
  });
});

describe("LaneResult", () => {
  it("parses the almost-right lane", () => {
    const parsed = LaneResult.parse(lane);
    expect(parsed.readings.map((r) => r.value)).toEqual(["$50.00", "$50.00", "$50.00", "$45.00"]);
    expect(parsed.stepLog.filter((s) => s.trigger)).toHaveLength(1);
  });

  it("requires a trigger time on a completed lane", () => {
    expect(issues(LaneResult, { ...lane, tTriggerMs: null })).toContain(
      "tTriggerMs: a completed lane has a trigger time",
    );
  });

  it("requires a trigger step when there's a trigger time", () => {
    const noTrigger = { ...lane, stepLog: lane.stepLog.map((s) => ({ ...s, trigger: false })) };
    expect(issues(LaneResult, noTrigger)).toEqual(["stepLog: a trigger time needs a trigger step"]);
  });

  it("allows a setup failure without a trigger", () => {
    const failed = {
      ...lane,
      status: "setup_failed",
      tTriggerMs: null,
      failedStepIndex: 1,
      readings: [],
    };
    expect(LaneResult.parse(failed).status).toBe("setup_failed");
  });

  it("rejects a failed step index past the log", () => {
    expect(issues(LaneResult, { ...lane, failedStepIndex: 4 })).toEqual([
      "failedStepIndex: points past the step log",
    ]);
  });

  it("requires video offsets whenever there's a video", () => {
    const withoutOffsets: Record<string, unknown> = { ...lane };
    delete withoutOffsets.videoOffsets;
    expect(issues(LaneResult, withoutOffsets)).toEqual([
      "videoOffsets: required when the lane has a video",
    ]);
  });

  it("rejects duplicate reading indices, which judges couldn't cite unambiguously", () => {
    const dup = { ...lane, readings: [reading(0, "pre", "$50.00"), reading(0, "post", "$50.00")] };
    expect(issues(LaneResult, dup)).toEqual(["readings.1.i: duplicate reading index 0"]);
  });
});
