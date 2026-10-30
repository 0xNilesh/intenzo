import { describe, expect, it } from "vitest";

import { CoverageMap, Criterion, CriterionSet } from "./criterion.ts";
import { issues } from "./test-helpers.ts";

const c2 = {
  id: "C2",
  text: "The order total updates instantly, without a refresh",
  trigger: "apply discount code SAVE10 on the cart page",
  setup: ["logged in", "cart has an item worth ≥ $50"],
  expected: "Order total changes from $50.00 to $45.00 within 1 s of Apply, without reload",
  watch: ["order total"],
  kind: "ui_behavior",
  persistence: true,
  timingMs: 1000,
  inferred: false,
  sourceQuote: "the total should drop 10% right away, no refresh",
  sourceMediaAt: 8200,
} as const;

const set = {
  criteria: [c2, { ...c2, id: "C3", watch: ["error message"], persistence: false }],
  repro: { startPath: "/cart", steps: ["open the cart", "type SAVE10", "click Apply"] },
  intentSource: "linked_issue_video",
  ticketHash: "a".repeat(64),
};

describe("Criterion", () => {
  it("parses a full criterion", () => {
    expect(Criterion.parse(c2)).toEqual(c2);
  });

  it.each([["c2"], ["C"], ["CR2"], ["C2a"]])("rejects the id %j with a clear path", (id) => {
    expect(issues(Criterion, { ...c2, id })).toEqual(["id: criterion ids look like C1, C2, …"]);
  });

  it("allows at most three watch targets", () => {
    expect(issues(Criterion, { ...c2, watch: ["a", "b", "c", "d"] })[0]).toMatch(/^watch: /);
  });

  it("rejects a non-positive timing claim", () => {
    expect(issues(Criterion, { ...c2, timingMs: 0 })[0]).toMatch(/^timingMs: /);
  });

  it("rejects an unknown kind", () => {
    expect(issues(Criterion, { ...c2, kind: "backend" })[0]).toMatch(/^kind: /);
  });
});

describe("CriterionSet", () => {
  it("parses a set from a video ticket", () => {
    expect(CriterionSet.parse(set).criteria.map((c) => c.id)).toEqual(["C2", "C3"]);
  });

  it("allows at most six criteria", () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ ...c2, id: `C${i + 1}` }));
    expect(issues(CriterionSet, { ...set, criteria: seven })[0]).toMatch(/^criteria: /);
  });

  it("rejects duplicate criterion ids, pointing at the second one", () => {
    expect(issues(CriterionSet, { ...set, criteria: [c2, c2] })).toEqual([
      "criteria.1.id: duplicate criterion id C2",
    ]);
  });

  it("requires ticketHash to be a sha256 hex digest", () => {
    expect(issues(CriterionSet, { ...set, ticketHash: "abc" })).toEqual([
      "ticketHash: must be a sha256 hex digest",
    ]);
  });

  it("requires repro.startPath to be a path", () => {
    expect(issues(CriterionSet, { ...set, repro: { startPath: "cart", steps: [] } })[0]).toMatch(
      /^repro\.startPath: /,
    );
  });
});

describe("CoverageMap", () => {
  it("parses items and routes", () => {
    const map = {
      items: [{ criterionId: "C2", files: ["app/cart/total.ts"], status: "covered" }],
      routes: ["/cart"],
    };
    expect(CoverageMap.parse(map)).toEqual(map);
  });

  it("rejects an unknown coverage status", () => {
    const map = { items: [{ criterionId: "C2", files: [], status: "maybe" }], routes: [] };
    expect(issues(CoverageMap, map)[0]).toMatch(/^items\.0\.status: /);
  });
});
