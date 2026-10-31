import { describe, expect, it } from "vitest";

import { describeEvent, parseRunArgs } from "./local-run.ts";
import { UsageError } from "./record.ts";

describe("intenzo run --local", () => {
  it("takes a PR app, a base app and a ticket or criteria", () => {
    expect(
      parseRunArgs([
        "--local",
        "--pr",
        "http://localhost:3001",
        "--base",
        "http://localhost:3000",
        "--ticket",
        "t.md",
      ]),
    ).toMatchObject({
      pr: "http://localhost:3001",
      base: "http://localhost:3000",
      ticket: "t.md",
      explore: false,
    });
    expect(
      parseRunArgs([
        "--local",
        "--pr",
        "http://x.test",
        "--criteria",
        "fixtures/criteria",
        "--explore",
      ]),
    ).toMatchObject({
      criteria: "fixtures/criteria",
      explore: true,
    });
  });

  it.each([
    [["--pr", "http://x.test", "--ticket", "t.md"], "only --local"],
    [["--local", "--ticket", "t.md"], "--pr <url> is required"],
    [["--local", "--pr", "http://x.test"], "give --ticket"],
    [["--local", "--pr", "http://x.test", "--ticket", "t.md", "--criteria", "c"], "not both"],
    [
      ["--local", "--pr", "http://x.test", "--criteria", "c", "--video", "v.mp4"],
      "--video goes with --ticket",
    ],
  ])("refuses %j", (argv, message) => {
    expect(() => parseRunArgs(argv)).toThrow(UsageError);
    expect(() => parseRunArgs(argv)).toThrow(message);
  });

  it("prints a verdict with each judge's citation", () => {
    const lines = describeEvent({
      kind: "criterion_verdict",
      verdict: {
        criterionId: "C2",
        verdict: "fail",
        reasonCode: "agreed",
        evidenceWindow: null,
        observed: "It stayed $50.00.",
        judges: [
          {
            model: "Spark Open",
            verdict: "fail",
            targetCorrect: true,
            citedReadings: [6],
            citedValue: "$50.00",
            atMs: null,
            observed: "",
          },
        ],
      },
      lanes: [],
    });
    expect(lines).toEqual([
      "C2 ❌ fail (agreed) · It stayed $50.00.",
      '   Spark Open: fail [6] "$50.00"',
    ]);
  });
});
