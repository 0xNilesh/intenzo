import { describe, expect, it } from "vitest";

import { formatDuration } from "./duration.js";

describe("formatDuration", () => {
  it.each([
    [0, "0 s"],
    [499, "0 s"],
    [500, "1 s"],
    [45_000, "45 s"],
    [84_000, "1 m 24 s"],
    [60_000, "1 m"],
    [112_000, "1 m 52 s"],
    [3_600_000, "1 h"],
    [3_780_000, "1 h 3 m"],
  ])("formats %i ms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it("drops seconds once the duration reaches an hour", () => {
    expect(formatDuration(3_601_000)).toBe("1 h");
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s", (ms) => {
    expect(() => formatDuration(ms)).toThrow(RangeError);
  });
});
