import { describe, expect, it } from "vitest";

import { diffLines, NO_CHANGE, snapshotLines } from "./regions.ts";

describe("snapshotLines", () => {
  it("drops list markers, indentation and blank lines", () => {
    expect(snapshotLines('- alert: This code has expired\n  - text: "x"\n\n')).toEqual([
      "alert: This code has expired",
      'text: "x"',
    ]);
    expect(snapshotLines("")).toEqual([]);
  });
});

describe("diffLines", () => {
  it("marks lines that appeared with + and lines that disappeared with -", () => {
    expect(diffLines([], ["alert: This code has expired"])).toBe("+ alert: This code has expired");
    expect(diffLines(["status: Saved"], [])).toBe("- status: Saved");
    expect(diffLines(["status: Saved"], ["status: Saved", "alert: Oops"])).toBe("+ alert: Oops");
  });

  it("says 'no change' when nothing appeared or disappeared, so a judge can cite it", () => {
    expect(diffLines([], [])).toBe(NO_CHANGE);
    expect(diffLines(["status: Saved"], ["status: Saved"])).toBe(NO_CHANGE);
  });

  it("counts repeated lines", () => {
    expect(diffLines(["status: Saved"], ["status: Saved", "status: Saved"])).toBe(
      "+ status: Saved",
    );
  });
});
