import { describe, expect, it } from "vitest";

import {
  checkJudge,
  combine,
  combineR13,
  numbersIn,
  valueMatches,
  type Checked,
} from "./combine.ts";
import type { Criterion, JudgeOutput, Reading } from "./schema.ts";

const reading = (i: number, value: string | null): Reading => ({
  i,
  label: "order total",
  kind: value === null ? "absent" : "text",
  phase: "post",
  tMs: 0,
  value,
  bbox: null,
});

describe("numbersIn", () => {
  it("reads whole numeric tokens as cents", () => {
    expect(numbersIn("$45.00")).toEqual([4500]);
    expect(numbersIn("−$1,234.50 and 45")).toEqual([123450, 4500]);
    expect(numbersIn("Discount (SAVE10) at 3s")).toEqual([]);
  });
});

describe("valueMatches (§22.3: tokens, not substrings)", () => {
  it.each([
    // [cited value, reading values, matches] — the first four are the cases T4.5 lists
    ["5.00", ["$45.00"], false],
    ["45", ["$45.00"], true],
    ['"This code has expired"', ['+ alert "This code has expired"'], true],
    ["", ["$45.00"], false],
    [null, ["$45.00"], false],
    ["$45.00", ["$45.00"], true],
    ["$50.00", ["$45.00", "$50.00"], true],
    ["−$5.00", ["Discount (SAVE10) −$5.00"], true],
    ["$5.00", ["Discount (SAVE10) −$4.99"], false],
    ["10", ["Discount (SAVE10) −$5.00"], false],
    ["1,234.50", ["$1234.50"], true],
    ["$50.00 at 1000 ms", ["$50.00"], false], // every number must be in a cited reading
    ["This code has expired", ["+ alert: This code has expired"], true],
    ["alert: This code has expired", ["+ alert: This code has expired"], true],
    ["+ alert: This code has expired", ["+ alert: This code has expired"], true],
    ["code has expired", ["+ alert: This code has expired"], false],
    ["Discount SAVE10 applied", ["+ status: Discount SAVE10 applied\n+ alert: Oops"], true],
    ["no change", ["no change"], true],
    ["Updating…", ["Updating…"], true],
    ["absent", [null], false],
  ])("%j vs %j → %s", (cited, values, expected) => {
    expect(
      valueMatches(
        cited,
        values.map((v, i) => reading(i, v)),
      ),
    ).toBe(expected);
  });
});

const criterion = (over: Partial<Criterion> = {}): Criterion => ({
  id: "C2",
  text: "The total updates to $45.00",
  trigger: "Apply SAVE10",
  setup: [],
  expected: "$45.00",
  watch: ["order total"],
  kind: "ui_behavior",
  persistence: false,
  inferred: false,
  ...over,
});

const judge = (over: Partial<JudgeOutput> = {}): JudgeOutput => ({
  verdict: "fail",
  targetCorrect: true,
  citedReadings: [1],
  citedValue: "$50.00",
  atMs: 2000,
  observed: "The total stayed at $50.00.",
  ...over,
});

describe("checkJudge (§22.3 per judge)", () => {
  const readings = [reading(0, "$50.00"), reading(1, "$50.00"), reading(2, "$45.00")];
  it.each<[string, JudgeOutput | null, Partial<Criterion>, Checked]>([
    ["a fail citing a matching reading stands", judge(), {}, { verdict: "fail", reason: null }],
    [
      "a pass citing a matching reading stands",
      judge({ verdict: "pass", citedReadings: [2], citedValue: "$45.00" }),
      {},
      { verdict: "pass", reason: null },
    ],
    [
      "a wrong target is inconclusive, whatever the verdict",
      judge({ targetCorrect: false }),
      {},
      { verdict: "inconclusive", reason: "wrong_target" },
    ],
    [
      "a cited value that isn't in the cited reading contradicts it",
      judge({ citedValue: "$45.00" }),
      {},
      { verdict: "inconclusive", reason: "contradicts_readings" },
    ],
    [
      "a decided verdict with no citation contradicts the readings",
      judge({ citedReadings: [] }),
      {},
      { verdict: "inconclusive", reason: "contradicts_readings" },
    ],
    [
      "citing a reading that doesn't exist contradicts the readings",
      judge({ citedReadings: [1, 9] }),
      {},
      { verdict: "inconclusive", reason: "contradicts_readings" },
    ],
    [
      "an inconclusive answer needs no citation",
      judge({ verdict: "inconclusive", citedReadings: [], citedValue: null }),
      {},
      { verdict: "inconclusive", reason: null },
    ],
    [
      "ui_visual criteria may be decided from the video alone",
      judge({ citedReadings: [], citedValue: null }),
      { kind: "ui_visual" },
      { verdict: "fail", reason: null },
    ],
    [
      "criteria that watch nothing need no citation",
      judge({ citedReadings: [], citedValue: null }),
      { watch: [] },
      { verdict: "fail", reason: null },
    ],
    [
      "no answer at all is an infra error",
      null,
      {},
      { verdict: "inconclusive", reason: "infra_error" },
    ],
  ])("%s", (_, output, over, expected) => {
    expect(checkJudge(output, criterion(over), readings)).toEqual(expected);
  });
});

const pass: Checked = { verdict: "pass", reason: null };
const fail: Checked = { verdict: "fail", reason: null };
const unsure: Checked = { verdict: "inconclusive", reason: null };
const inconclusive = (reason: Checked["reason"]): Checked => ({ verdict: "inconclusive", reason });

describe("combine (§22.3: both judges must agree)", () => {
  it.each<[string, Checked, Checked, ReturnType<typeof combine>]>([
    ["agreed pass", pass, pass, { verdict: "pass", reason: "agreed" }],
    ["agreed fail", fail, fail, { verdict: "fail", reason: "agreed" }],
    ["pass vs fail", pass, fail, { verdict: "inconclusive", reason: "judges_disagree" }],
    ["fail vs unsure", fail, unsure, { verdict: "inconclusive", reason: "judges_disagree" }],
    ["both unsure", unsure, unsure, { verdict: "inconclusive", reason: "judges_disagree" }],
    [
      "a wrong target",
      pass,
      inconclusive("wrong_target"),
      { verdict: "inconclusive", reason: "wrong_target" },
    ],
    [
      "a bad citation",
      inconclusive("contradicts_readings"),
      fail,
      { verdict: "inconclusive", reason: "contradicts_readings" },
    ],
    [
      "a missing judge outranks the other reasons",
      inconclusive("wrong_target"),
      inconclusive("infra_error"),
      { verdict: "inconclusive", reason: "infra_error" },
    ],
  ])("%s", (_, a, b, expected) => {
    expect(combine(a, b)).toEqual(expected);
  });
});

describe("combineR13 (§34 R13 fallback)", () => {
  it("passes on the primary judge alone, but still needs both judges to fail", () => {
    expect(combineR13(pass, fail)).toEqual({ verdict: "pass", reason: "primary_pass" });
    expect(combineR13(pass, unsure)).toEqual({ verdict: "pass", reason: "primary_pass" });
    expect(combineR13(fail, fail)).toEqual({ verdict: "fail", reason: "agreed" });
    expect(combineR13(fail, pass)).toEqual({ verdict: "inconclusive", reason: "judges_disagree" });
    expect(combineR13(inconclusive("contradicts_readings"), pass)).toEqual({
      verdict: "inconclusive",
      reason: "contradicts_readings",
    });
  });
});
