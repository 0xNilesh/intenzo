import { describe, expect, it } from "vitest";

import { BenchCase, loadCases, loadTicket, splitCounts, TICKETS } from "./case.ts";
import { CHECKS, SIDE_EFFECTS } from "./ground-truth.ts";

const cases = loadCases();

describe("IntentBench's cases (§31)", () => {
  it("has 12 cases on 4 tickets: 4 correct, 5 seeded almost-right, 2 side-effect, 1 broken", () => {
    expect(cases).toHaveLength(12);
    const kinds = cases.reduce<Record<string, number>>(
      (n, c) => ({ ...n, [c.kind]: (n[c.kind] ?? 0) + 1 }),
      {},
    );
    expect(kinds).toEqual({ correct: 4, almost_right: 5, side_effect: 2, broken: 1 });
    expect(cases.filter((c) => c.seeded).map((c) => c.kind)).toEqual(Array(5).fill("almost_right"));
    expect(new Set(cases.map((c) => c.ticket))).toEqual(new Set(TICKETS));
    // Every ticket's correct case is the one Muse Code wrote.
    for (const t of TICKETS) {
      expect(cases.find((c) => c.ticket === t && c.kind === "correct")?.note).toContain(
        "Muse Code",
      );
    }
  });

  it("splits them as §31 says: 4 for tuning, 8 held out", () => {
    expect(splitCounts(cases)).toEqual({
      tuning: { correct: 1, almost_right: 2, side_effect: 1 },
      heldout: { correct: 3, almost_right: 3, side_effect: 1, broken: 1 },
    });
  });

  it("labels about 40 criteria, each with a ground-truth check", () => {
    const labelled = cases.reduce((n, c) => n + Object.keys(c.labels).length, 0);
    expect(labelled).toBe(42);
    for (const t of TICKETS) {
      const ticket = loadTicket(t);
      expect(ticket.title.length).toBeGreaterThan(0);
      expect(Object.keys(CHECKS[t]).sort()).toEqual(ticket.criteria.map((c) => c.id).sort());
    }
    for (const c of cases.filter((c) => c.kind === "side_effect")) {
      expect(SIDE_EFFECTS[c.id]).toBeTypeOf("function");
    }
  });

  it.each([
    ["an almost-right case that isn't seeded", { seeded: false }],
    [
      "a correct case with a failing label",
      { kind: "correct", seeded: false, labels: { C1: "fail", C2: "pass" } },
    ],
    ["an almost-right case that fails nothing", { labels: { C1: "pass", C2: "pass" } }],
    [
      "a side effect on a case that isn't one",
      { sideEffect: { route: "/cart", description: "x" } },
    ],
    [
      "a broken case that passes something",
      { kind: "broken", seeded: false, labels: { C1: "pass", C2: "fail" } },
    ],
  ])("refuses %s", (_, change) => {
    const valid = {
      id: "x-almost-right",
      ticket: "discount",
      branch: "bench/x-almost-right",
      kind: "almost_right",
      seeded: true,
      split: "tuning",
      labels: { C1: "pass", C2: "fail" },
      sideEffect: null,
      note: "seeded",
    };
    expect(BenchCase.safeParse(valid).success).toBe(true);
    expect(BenchCase.safeParse({ ...valid, ...change }).success).toBe(false);
  });
});
