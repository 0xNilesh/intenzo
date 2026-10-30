import { describe, expect, it } from "vitest";

import { REQUESTED_ACTIONS } from "./actions.ts";

describe("the §26.2 requested actions", () => {
  it("fit GitHub's limits: at most 3, label ≤ 20, description ≤ 40, identifier ≤ 20", () => {
    expect(REQUESTED_ACTIONS.length).toBeLessThanOrEqual(3);
    for (const action of REQUESTED_ACTIONS) {
      expect(action.label.length).toBeLessThanOrEqual(20);
      expect(action.description.length).toBeLessThanOrEqual(40);
      expect(action.identifier.length).toBeLessThanOrEqual(20);
    }
  });

  it("use the labels the comment and §26.2 promise", () => {
    expect(REQUESTED_ACTIONS.map((a) => a.label)).toEqual([
      "Approve (PM)",
      "Send to agent",
      "Re-run",
    ]);
  });
});
