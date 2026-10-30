import { describe, expect, it } from "vitest";

import { issues } from "./test-helpers.ts";
import { JudgeOutput, RunOutcome, Verdict } from "./verdict.ts";

const judge = {
  verdict: "fail",
  targetCorrect: true,
  citedReadings: [2],
  citedValue: "$50.00",
  atMs: 1_793_000_004_200,
  observed: "After Apply the total stayed $50.00; it only showed $45.00 after the reload.",
} as const;

const verdict = {
  criterionId: "C2",
  verdict: "fail",
  reasonCode: "agreed",
  evidenceWindow: { startMs: 1_793_000_002_200, endMs: 1_793_000_006_200 },
  observed: judge.observed,
  judges: [
    { ...judge, model: "meta-models/muse-spark-open" },
    { ...judge, model: "muse-spark-1.3" },
  ],
};

describe("JudgeOutput", () => {
  it("parses a judge's answer", () => {
    expect(JudgeOutput.parse(judge)).toEqual(judge);
  });

  it("allows a null citation and time (e.g. a visual criterion)", () => {
    expect(JudgeOutput.parse({ ...judge, citedValue: null, atMs: null }).citedValue).toBeNull();
  });

  it("rejects a non-integer reading index", () => {
    expect(issues(JudgeOutput, { ...judge, citedReadings: [1.5] })[0]).toMatch(
      /^citedReadings\.0: /,
    );
  });
});

describe("Verdict", () => {
  it("parses an agreed fail with both judges", () => {
    expect(Verdict.parse(verdict).judges.map((j) => j.model)).toEqual([
      "meta-models/muse-spark-open",
      "muse-spark-1.3",
    ]);
  });

  it("only allows pass or fail when the judges agreed", () => {
    expect(issues(Verdict, { ...verdict, reasonCode: "judges_disagree" })).toEqual([
      "reasonCode: pass and fail need two agreeing judges",
    ]);
  });

  it("requires a reason for an inconclusive verdict", () => {
    expect(issues(Verdict, { ...verdict, verdict: "inconclusive" })).toEqual([
      "reasonCode: an inconclusive verdict needs its reason",
    ]);
    expect(
      Verdict.parse({ ...verdict, verdict: "inconclusive", reasonCode: "flaky" }).reasonCode,
    ).toBe("flaky");
  });

  it("rejects an evidence window that ends before it starts", () => {
    const backwards = { ...verdict, evidenceWindow: { startMs: 10, endMs: 5 } };
    expect(issues(Verdict, backwards)).toEqual(["evidenceWindow.endMs: ends before it starts"]);
  });

  it("rejects an unknown reason", () => {
    expect(issues(Verdict, { ...verdict, reasonCode: "vibes" })[0]).toMatch(/^reasonCode: /);
  });
});

describe("RunOutcome", () => {
  it("includes superseded runs", () => {
    expect(RunOutcome.parse("superseded")).toBe("superseded");
  });
});
