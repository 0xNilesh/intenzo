import { describe, expect, it } from "vitest";

import { SavedPath } from "../schema/index.ts";
import { changeRoutes, changeTargets, skipChanges } from "./plan.ts";

const path = (criterionId: string, goto: string | null) =>
  SavedPath.parse({
    criterionId,
    setup: goto ? [{ op: "goto", path: goto }] : [],
    trigger: [
      { op: "fill", target: { by: "label", text: "Discount code" }, value: "SAVE10" },
      { op: "click", target: { by: "role", role: "button", name: "Apply" } },
    ],
    watch: [
      { label: "order total", scope: "element", target: { by: "testId", id: "total" } },
      {
        label: "order summary",
        scope: "region",
        target: { by: "role", role: "region", name: "Order summary" },
      },
    ],
    portable: true,
  });

describe("the aria diff's plan (§24)", () => {
  it("skips without a baseline, an isolated base side, or on a drifted baseline", () => {
    const base = { baseUrl: "https://base.example", baseIsolated: true };
    expect(skipChanges(base)).toBeNull();
    expect(skipChanges({ ...base, baseDrift: 0 })).toBeNull();
    expect(skipChanges({ ...base, baseUrl: null })).toBe("no baseline");
    expect(skipChanges({ ...base, baseIsolated: false })).toBe("the base side isn't isolated");
    expect(skipChanges({ ...base, baseDrift: 2 })).toBe(
      "the baseline is 2 commits before the merge base",
    );
  });

  it("checks the criteria's routes and coverage's, without ephemeral ids, at most two", () => {
    expect(
      changeRoutes([path("C1", "/cart"), path("C2", "/cart?x=1")], ["/checkout"], "/"),
    ).toEqual(["/cart", "/checkout"]);
    expect(changeRoutes([path("C1", null)], [], "/products")).toEqual(["/products"]);
    expect(
      changeRoutes([], ["/orders/8f3a9c21b7e4", "/orders/12345", "/a", "/b", "/c"], "/"),
    ).toEqual(["/a", "/b"]);
    // No path and no mapped route: the start route.
    expect(changeRoutes([], [], "/cart")).toEqual(["/cart"]);
  });

  it("touches the trigger's targets and the watched elements, not the watched regions", () => {
    expect(changeTargets([path("C1", "/cart")])).toEqual([
      { by: "label", text: "Discount code" },
      { by: "role", role: "button", name: "Apply" },
      { by: "testId", id: "total" },
    ]);
  });
});
