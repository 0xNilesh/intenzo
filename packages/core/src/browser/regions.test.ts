import { describe, expect, it } from "vitest";

import { diffLines, NO_CHANGE, snapshotLines } from "./regions.ts";

describe("snapshotLines", () => {
  it("drops list markers, indentation and blank lines", () => {
    expect(
      snapshotLines('- region "Cart":\n  - heading "Cart" [level=1]\n\n  - text: $50.00'),
    ).toEqual(['region "Cart":', 'heading "Cart" [level=1]', "text: $50.00"]);
  });
});

describe("diffLines", () => {
  it("lists added lines first, then removed ones", () => {
    expect(diffLines(["text: $50.00", "button: Apply"], ["text: $45.00", "button: Apply"])).toBe(
      "+ text: $45.00\n- text: $50.00",
    );
  });

  it("counts repeated lines as a multiset", () => {
    expect(diffLines(["listitem: Mug"], ["listitem: Mug", "listitem: Mug"])).toBe(
      "+ listitem: Mug",
    );
  });

  it("says no change when the lines match in any order", () => {
    expect(diffLines(["a", "b"], ["b", "a"])).toBe(NO_CHANGE);
  });

  it("treats a region that was empty before as all additions", () => {
    expect(diffLines([], ["alert: This code has expired"])).toBe("+ alert: This code has expired");
  });
});
