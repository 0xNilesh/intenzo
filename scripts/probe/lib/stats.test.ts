import { describe, expect, it } from "vitest";

import { latency, median } from "./stats.ts";

describe("median", () => {
  it("takes the middle sample of an odd count, regardless of order", () => {
    expect(median([900, 100, 300, 500, 700])).toBe(500);
  });

  it("averages the two middle samples of an even count", () => {
    expect(median([100, 400, 200, 300])).toBe(250);
  });

  it("rejects an empty sample list", () => {
    expect(() => median([])).toThrow(RangeError);
  });
});

describe("latency", () => {
  it("rounds the p50 and every sample to whole milliseconds", () => {
    expect(latency([812.4, 790.6, 1203.5])).toEqual({ p50: 812, samples: [812, 791, 1204] });
  });
});
