import { describe, expect, it } from "vitest";

import { aboutOf, goldenProblems, readRows } from "./lib/p4.ts";

// The check run summary of demo-shop#17's first run, as GitHub stored it (links shortened).
const ALMOST_RIGHT = `| | Criterion | Evidence |
|---|---|---|
| ❌ | **C1** Applying SAVE10 drops order total from $50.00 to $45.00 right away with no refresh | [▶ 0:00–0:03](https://r/#C1) |
| | Expected: the order total changes from $50.00 to $45.00 without a page refresh · Readings: +0 s $50.00 · +1 s $50.00 · +3 s $50.00 · Observed: It stayed $50.00. | |
| ✅ | **C2** Discount shows as its own line in the summary as SAVE10 minus $5.00 | [▶ 0:00–0:03](https://r/#C2) |
| ✅ | **C3** Applying OLD5 shows 'This code has expired' | [▶ 0:00–0:03](https://r/#C3) |
| ✅ | **C4** Savings chart in the summary shows the discount slice after applying SAVE10 | [▶ 0:00–0:03](https://r/#C4) |

Baseline: \`b6b60c7\` (the merge base) · Judges: Spark Open + Spark 1.3`;

describe("the P4 gate's golden match", () => {
  it("reads each row's verdict and a failed row's readings", () => {
    expect(readRows(ALMOST_RIGHT)).toEqual([
      expect.objectContaining({
        id: "C1",
        verdict: "fail",
        readings: "+0 s $50.00 · +1 s $50.00 · +3 s $50.00",
      }),
      expect.objectContaining({ id: "C2", verdict: "pass", readings: null }),
      expect.objectContaining({ id: "C3", verdict: "pass" }),
      expect.objectContaining({ id: "C4", verdict: "pass" }),
    ]);
  });

  it.each([
    ["Applying SAVE10 drops order total from $50.00 to $45.00 right away with no refresh", "total"],
    ["The total drops 10% to $45.00 right away, with no refresh", "total"],
    ["Discount shows as its own line in the summary as SAVE10 minus $5.00", "line"],
    ['SAVE10 adds a "SAVE10 −$5.00" discount line', "line"],
    ["Applying OLD5 shows 'This code has expired'", "expired"],
    ["Savings chart in the summary shows the discount slice after applying SAVE10", "chart"],
    ["The page loads", null],
  ])("%j is about the %s", (text, about) => {
    expect(aboutOf(text)).toBe(about);
  });

  it("matches the almost-right run by what each criterion is about, whatever its number", () => {
    expect(goldenProblems("almost-right", "3/4 passed", readRows(ALMOST_RIGHT))).toEqual([]);
  });

  it("names what differs", () => {
    // A passing row has no detail row (§26.1).
    const passing = readRows(
      ALMOST_RIGHT.replace("| ❌ | **C1**", "| ✅ | **C1**").replace(
        /\n\| \| Expected:.*\| \|/,
        "",
      ),
    );
    expect(goldenProblems("almost-right", "4/4 passed", passing)).toEqual([
      'outcome "4/4 passed", not "3/4 passed"',
      "the total (C1) is pass, not fail",
      'the total\'s readings are "null", not "+0 s $50.00 · +1 s $50.00 · +3 s $50.00…"',
    ]);
    expect(goldenProblems("correct", "4/4 passed", passing)).toEqual([]);
  });
});
