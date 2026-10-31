import { describe, expect, it } from "vitest";

import { parseCoverageArgs, readCriteria } from "./coverage.ts";
import { REPO, UsageError } from "./record.ts";

describe("intenzo coverage", () => {
  it("reads a folder of criterion files in id order", () => {
    expect(readCriteria(`${REPO}/fixtures/criteria`).map((c) => c.id)).toEqual([
      "C1",
      "C2",
      "C3",
      "C4",
    ]);
  });

  it("needs criteria and a diff", () => {
    expect(parseCoverageArgs(["--criteria", "c", "--diff", "d.json"])).toEqual({
      criteria: "c",
      diff: "d.json",
      model: "muse-spark-1.3",
    });
    expect(() => parseCoverageArgs(["--diff", "d.json"])).toThrow(UsageError);
    expect(() => parseCoverageArgs(["--criteria", "c"])).toThrow(UsageError);
  });
});
