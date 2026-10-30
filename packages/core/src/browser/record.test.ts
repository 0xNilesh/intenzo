import { describe, expect, it } from "vitest";

import { postOffsets } from "./record.ts";

describe("postOffsets", () => {
  it.each([
    [undefined, [0, 1000, 3000]],
    [500, [0, 500, 1000, 3000]],
    [1000, [0, 1000, 3000]],
    [5000, [0, 1000, 3000, 5000]],
  ])("timingMs %s → %j", (timingMs, expected) => {
    expect(postOffsets(timingMs === undefined ? {} : { timingMs })).toEqual(expected);
  });
});
