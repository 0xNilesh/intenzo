import { describe, expect, it } from "vitest";

import {
  evidenceCells,
  failedRunProblems,
  loopProblems,
  passedRunProblems,
  UNREQUESTED,
} from "./p5.ts";

// demo-shop #22's first run (T5.6), as its check run summarised it.
const GIF = (c: string) =>
  `![${c}](https://klfpiscdv04whptv.public.blob.vercel-storage.com/runs/r/${c}/pr/take-1/evidence.gif)`;
const FAILED = [
  "| | Criterion | Evidence |",
  "|---|---|---|",
  `| ❌ | **C1** Applying SAVE10 drops the order total from $50.00 to $45.00 | ${GIF("C1")} |`,
  "| | Expected: the order total changes · Readings: +0 s $50.00 · +1 s $50.00 · +3 s $50.00 · Observed: it stayed | |",
  "| ✅ | **C2** Discount shows as its own line in the summary with SAVE10 minus $5.00 | [▶ 0:00–0:03](https://intenzo/r/r#C2) |",
  "| ✅ | **C3** Applying OLD5 shows this code has expired | [▶ 0:00–0:03](https://intenzo/r/r#C3) |",
  `| ✅ | **C4** The summary savings chart shows the discount slice | ${GIF("C4")} |`,
  "",
  UNREQUESTED,
].join("\n");

describe("the Phase 5 gate's checks", () => {
  it("passes the almost-right PR's first run: golden verdicts, both GIFs, the ⚠️ line", () => {
    expect(failedRunProblems("3/4 passed", FAILED)).toEqual([]);
    expect(evidenceCells(FAILED).total).toBe(GIF("C1"));
  });

  it("names what's missing from it", () => {
    const bare = FAILED.replace(GIF("C4"), "[▶ 0:00–0:03](https://intenzo/r/r#C4)").replace(
      UNREQUESTED,
      "",
    );
    expect(failedRunProblems("3/4 passed", bare)).toEqual([
      "the chart's SAM GIF isn't inline",
      `no "${UNREQUESTED}"`,
    ]);
    expect(failedRunProblems("4/4 passed", FAILED)[0]).toBe(
      'outcome "4/4 passed", not "3/4 passed"',
    );
  });

  it("wants every criterion ✅ on the fixer's commit", () => {
    const passed = FAILED.replace("| ❌ | **C1**", "| ✅ | **C1**");
    expect(passedRunProblems("4/4 passed", passed)).toEqual([]);
    expect(passedRunProblems("3/4 passed", FAILED)).toContain("the total (C1) is fail, not pass");
  });

  it("checks the loop: one request, the fixer's commit through CI, the approval, the merge", () => {
    const loop = {
      fixRequests: 1,
      fixer: { sha: "d9ca5c2", ci: "success" },
      approval: { state: "success", description: "Approved by sumithprabhu" },
      mergeableState: "clean",
      required: ["Intenzo / product approval"],
    };
    expect(loopProblems(loop)).toEqual([]);
    expect(
      loopProblems({
        ...loop,
        fixRequests: 2,
        fixer: null,
        approval: null,
        mergeableState: "blocked",
        required: [],
      }),
    ).toEqual([
      "2 fix requests, not 1",
      "no commit by intenzo-fixer[bot]",
      "no product approval",
      "main doesn't require the product approval",
      'merge state "blocked"',
    ]);
  });
});
