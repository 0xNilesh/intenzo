import { LaneResult } from "@intenzo/core";
import { describe, expect, it } from "vitest";

import { SideTruth } from "./lib/p1.ts";
import { hostedLaneProblems, videoSources } from "./lib/p2.ts";

const T0 = 1_900_000_000_000;
const truth = SideTruth.parse({
  status: "completed",
  readings: [
    { label: "order total", phase: "post", atMs: [0, 1000], kind: "text", value: "$50.00" },
  ],
});
const lane = LaneResult.parse({
  criterionId: "C2",
  side: "pr",
  status: "completed",
  laneStartMs: T0,
  tTriggerMs: T0 + 5000,
  stepLog: [
    {
      tMs: T0 + 5000,
      step: { op: "fill", target: { by: "label", text: "Discount code" }, value: "SAVE10" },
      ok: true,
      trigger: true,
    },
  ],
  readings: [0, 1000].map((at, i) => ({
    i,
    label: "order total",
    kind: "text",
    phase: "post",
    tMs: T0 + 5000 + at,
    value: "$50.00",
    bbox: null,
  })),
  consoleErrorCount: 0,
  failedRequestCount: 0,
  isolation: "ephemeral_user",
  humanVideo: { store: "private", path: "runs/r/C2/pr/take-1/human.mp4", contentType: "video/mp4" },
  videoOffsets: { human: -T0, judge: -T0 },
});

describe("hostedLaneProblems", () => {
  it("passes a lane that reads the ground truth and cites its video", () => {
    expect(hostedLaneProblems(truth, lane, [0, 1000, 3000])).toEqual([]);
  });

  it("names a missing lane, video or offsets", () => {
    expect(hostedLaneProblems(truth, undefined, [0])).toEqual(["not recorded"]);
    const bare: LaneResult = structuredClone(lane);
    delete bare.humanVideo;
    delete bare.videoOffsets;
    expect(hostedLaneProblems(truth, bare, [0, 1000, 3000])).toEqual([
      "no human video (video/mp4)",
      "no video offsets",
    ]);
  });

  it("keeps P1's reading checks", () => {
    const wrong = { ...lane, readings: lane.readings.map((r) => ({ ...r, value: "$45.00" })) };
    expect(hostedLaneProblems(truth, wrong, [0, 1000, 3000]).join("\n")).toMatch(/\$50\.00/);
  });
});

describe("videoSources", () => {
  it("reads each video's URL, with &amp; undone", () => {
    const html =
      '<video controls preload="metadata" width="440" src="https://x.blob/a.mp4?sig=1&amp;exp=2#t=0.0,3.3"></video>' +
      '<p>between</p><video src="https://x.blob/b.mp4?sig=3"></video>';
    expect(videoSources(html)).toEqual([
      "https://x.blob/a.mp4?sig=1&exp=2#t=0.0,3.3",
      "https://x.blob/b.mp4?sig=3",
    ]);
  });
});
