import { describe, expect, it } from "vitest";

import { isPng, readmeProblems, resultsProblems, type ResultsFile } from "./lib/p6.ts";

const criteria = [
  { caseId: "x", criterionId: "C1" },
  { caseId: "y", criterionId: "C1" },
];
const judges = {
  A: ["spark-1.3"],
  B: ["spark-1.3"],
  C: ["spark-1.3"],
  D: ["dual", "spark-open", "spark-1.3"],
} as const;
const complete = (repeats = 2): ResultsFile => ({
  split: "heldout",
  stoppedAtCap: false,
  rows: Object.entries(judges).flatMap(([arm, js]) =>
    js.flatMap((judge) =>
      Array.from({ length: repeats }, (_, k) => k + 1).flatMap((repeat) =>
        criteria.map((c) => ({ arm, judge, repeat, split: "heldout", ...c })),
      ),
    ),
  ),
});

describe("resultsProblems", () => {
  it("accepts every arm and judge, every criterion, 2 repeats", () => {
    expect(resultsProblems(complete(), criteria)).toEqual([]);
  });

  it("needs a spread: at least 2 repeats an arm", () => {
    expect(resultsProblems(complete(1), criteria)).toContain(
      "arm A has 1 repeat(s): a spread needs 2 or more",
    );
  });

  it("finds a missing criterion, a missing judge of arm D, a capped run and the wrong split", () => {
    const r = complete();
    r.rows = r.rows.filter(
      (row) =>
        !(row.arm === "D" && row.judge === "spark-open" && row.repeat === 2 && row.caseId === "y"),
    );
    r.stoppedAtCap = true;
    r.split = "tuning";
    expect(resultsProblems(r, criteria)).toEqual([
      "the results are for the tuning split, not heldout",
      "the run stopped at its spend cap",
      "arm D (spark-open) repeat 2 misses 1 criteria, e.g. y C1",
    ]);
  });
});

describe("readmeProblems", () => {
  const readme =
    "# X\n\n## IntentBench: x\n\n| Arm |\n| --- |\n| A | a |\n| B | b |\n| C | c |\n| D | d |\n\n**Small n:** 8 cases.\n\n## License\n";

  it("accepts the section with a row per arm and the caveat", () => {
    expect(readmeProblems(readme)).toEqual([]);
  });

  it("allows the padding Prettier puts in table cells", () => {
    expect(readmeProblems(readme.replace("| A | a |", "| A   | a   |"))).toEqual([]);
  });

  it("reports a missing arm, the missing caveat, or no section", () => {
    expect(
      readmeProblems(readme.replace("| C | c |\n", "").replace("**Small n:** 8 cases.", "")),
    ).toEqual(["no table row for arm C", "no small-n caveat"]);
    expect(readmeProblems("# X\n")).toEqual(["no IntentBench section"]);
  });
});

describe("isPng", () => {
  it("knows a PNG by its signature", () => {
    expect(isPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(true);
    expect(isPng(new TextEncoder().encode("not a png"))).toBe(false);
  });
});
