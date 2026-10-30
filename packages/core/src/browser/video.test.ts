import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { LoggedStep, StepLogEntry } from "../schema/index.ts";
import {
  CAPTION_MS,
  captionSpans,
  captionText,
  cutAfterMarker,
  describeStep,
  formatStamp,
  judgeTimeline,
  nextTakeDir,
} from "./video.ts";

const apply = { by: "role", role: "button", name: "Apply" } as const;
const entry = (tMs: number, step: LoggedStep = { op: "click", target: apply }): StepLogEntry => ({
  tMs,
  step,
  ok: true,
  trigger: false,
});

describe("formatStamp", () => {
  it.each([
    [12_250, "t=12.250s"],
    [0, "t=0.000s"],
    [999.6, "t=1.000s"],
    [-250, "t=-0.250s"],
    [-0.4, "t=0.000s"], // never "t=-0.000s"
  ])("%d ms → %s", (ms, stamp) => {
    expect(formatStamp(ms)).toBe(stamp);
  });
});

describe("judgeTimeline", () => {
  it("starts on the first 250 ms grid point (from the lane start) at or after the cut", () => {
    expect(judgeTimeline(1_000_001_010, 1_000_000_000)).toEqual({
      firstSlot: 5,
      startCanonical: 1_000_001_250,
      offsetMs: -1_000_001_250,
    });
  });

  it("starts on the cut itself when it falls on the grid, despite float noise", () => {
    expect(judgeTimeline(1000.0000001, 0).firstSlot).toBe(4);
    expect(judgeTimeline(1000, 0)).toEqual({ firstSlot: 4, startCanonical: 1000, offsetMs: -1000 });
  });

  it("maps canonical time to file time: frame n is canonical startCanonical + n × 250", () => {
    const timeline = judgeTimeline(10_300.5, 10_000.25);
    expect(timeline.startCanonical + timeline.offsetMs).toBe(0);
    expect(formatStamp((timeline.firstSlot + 3) * 250)).toBe("t=1.250s");
  });
});

describe("cutAfterMarker", () => {
  const times = [0, 40, 80, 120, 160, 200, 240, 280, 320, 360, 400, 440];
  const green = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]; // the marker is on from 80 to 360

  it("starts on the first frame after the marker has gone", () => {
    expect(cutAfterMarker(times, green, 80)).toBe(400);
  });

  it("can't start on the marker when its time was estimated a frame early (trace fallback)", () => {
    expect(cutAfterMarker(times, green, 40)).toBe(400);
  });

  it("starts at the first frame when there was no marker", () => {
    expect(cutAfterMarker([20, 60], [], null)).toBe(20);
  });

  it("cuts by the clock when the marker never visibly ends", () => {
    const allGreen = times.map(() => 1);
    expect(cutAfterMarker(times, allGreen, 0)).toBe(400); // first frame ≥ 0 + 300 + 100
  });
});

describe("captionSpans", () => {
  it("shows a step's caption for CAPTION_MS from its time, in file ms", () => {
    expect(captionSpans([entry(5000)], -4000)).toEqual([
      {
        fromMs: 1000,
        toMs: 1000 + CAPTION_MS,
        lines: [{ text: "click: Apply", trigger: false, ok: true }],
      },
    ]);
  });

  it("stacks steps that come close together instead of cutting the first one short", () => {
    const fill: LoggedStep = { op: "fill", target: { by: "label", text: "Code" }, value: "SAVE10" };
    const spans = captionSpans([entry(200, fill), entry(100, fill), entry(300)], 0);
    expect(spans.map((s) => [s.fromMs, s.toMs, s.lines.length])).toEqual([
      [100, 200, 1],
      [200, 300, 2],
      [300, 1600, 3],
      [1600, 1700, 2],
      [1700, 1800, 1],
    ]);
    expect(spans[2]!.lines.at(-1)!.text).toBe("click: Apply"); // the newest is at the bottom
  });

  it("keeps at most three lines", () => {
    const spans = captionSpans(
      [0, 10, 20, 30].map((t) => entry(t)),
      0,
    );
    expect(Math.max(...spans.map((s) => s.lines.length))).toBe(3);
  });

  it("drops captions that ended before the cut and clips the ones running across it", () => {
    expect(captionSpans([entry(-2000), entry(-500)], 0)).toEqual([
      { fromMs: 0, toMs: 1000, lines: [{ text: "click: Apply", trigger: false, ok: true }] },
    ]);
  });

  it("marks failed steps", () => {
    expect(captionText({ step: { op: "press", key: "Enter" }, ok: false })).toBe(
      "press: Enter (failed)",
    );
  });
});

describe("describeStep", () => {
  it.each<[LoggedStep, string]>([
    [{ op: "goto", path: "/cart" }, "goto: /cart"],
    [{ op: "click", target: apply }, "click: Apply"],
    [{ op: "click", target: { by: "role", role: "checkbox", name: "" } }, "click: checkbox"],
    [{ op: "click", target: { by: "testId", id: "apply-btn" } }, "click: testid apply-btn"],
    [{ op: "click", target: { by: "css", selector: "main > button" } }, "click: main > button"],
    [
      { op: "click", target: { by: "point", x: 10.4, y: 20.6, viewport: [1280, 720] } },
      "click: (10, 21)",
    ],
    [
      { op: "fill", target: { by: "label", text: "Discount code" }, value: "SAVE10" },
      'fill: Discount code = "SAVE10"',
    ],
    [
      { op: "fill", target: { by: "placeholder", text: "Password" }, value: "hunter2" },
      'fill: Password = "••••••"',
    ],
    [{ op: "select", target: { by: "label", text: "Size" }, option: "M" }, 'select: Size = "M"'],
    [{ op: "press", key: "Enter" }, "press: Enter"],
    [{ op: "scroll", direction: "down" }, "scroll down"],
    [{ op: "wait", ms: 500 }, "wait: 500 ms"],
    [{ op: "back" }, "back"],
    [{ op: "reload" }, "reload"],
  ])("%j → %s", (step, text) => {
    expect(describeStep(step)).toBe(text);
  });

  it("shortens long values", () => {
    const step: LoggedStep = {
      op: "fill",
      target: { by: "label", text: "Note" },
      value: "x".repeat(100),
    };
    expect(describeStep(step)).toBe(`fill: Note = "${"x".repeat(47)}…"`);
  });
});

describe("nextTakeDir", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("creates take-1, then take-2, leaving the earlier take as it was", () => {
    root = mkdtempSync(join(tmpdir(), "intenzo-takes-"));
    const first = nextTakeDir(root, "C2", "pr");
    expect(first).toBe(join(root, "C2", "pr", "take-1"));
    writeFileSync(join(first, "human.mp4"), "first");
    const second = nextTakeDir(root, "C2", "pr");
    expect(second).toBe(join(root, "C2", "pr", "take-2"));
    expect(readdirSync(first)).toEqual(["human.mp4"]);
    expect(readdirSync(second)).toEqual([]);
    expect(nextTakeDir(root, "C2", "base")).toBe(join(root, "C2", "base", "take-1"));
  });

  it("numbers after the highest take, even with gaps", () => {
    root = mkdtempSync(join(tmpdir(), "intenzo-takes-"));
    mkdirSync(join(root, "C1", "pr", "take-3"), { recursive: true });
    expect(nextTakeDir(root, "C1", "pr")).toBe(join(root, "C1", "pr", "take-4"));
  });

  it("refuses a criterion id that isn't one (no path tricks)", () => {
    root = mkdtempSync(join(tmpdir(), "intenzo-takes-"));
    expect(() => nextTakeDir(root, "../C1", "pr")).toThrow();
  });
});
