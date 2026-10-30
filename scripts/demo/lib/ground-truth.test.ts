import { describe, expect, it } from "vitest";

import { aliasUrl, expectationsFor } from "./ground-truth.ts";

describe("demo branch ground truth", () => {
  it("differs between the branches only in the total (C2) and the button label", () => {
    const correct = expectationsFor("correct");
    const almost = expectationsFor("almost-right");
    const differing = correct.filter((e, n) => e.expected !== almost[n]!.expected);
    expect(differing.map((e) => e.criterion)).toEqual(["C2", "change"]);
  });

  it("expects the stale total only before the reload on almost-right", () => {
    expect(expectationsFor("almost-right")[1]!.expected).toBe(
      "$50.00, $50.00, $50.00; reload $45.00",
    );
    expect(expectationsFor("correct")[1]!.expected).toBe("$45.00, $45.00, $45.00; reload $45.00");
  });

  it("knows each branch's Vercel alias", () => {
    expect(aliasUrl("pr/discount-almost-right")).toBe(
      "https://demo-shop-git-pr-discount-almost-right-sumithprabhus-projects.vercel.app",
    );
  });
});
