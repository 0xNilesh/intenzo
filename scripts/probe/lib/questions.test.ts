import { describe, expect, it } from "vitest";

import { amounts, scoreImage, scoreOk, scoreTotals, scoreTranscript } from "./questions.ts";

describe("scoreTotals", () => {
  it.each([
    "start=50, end=45",
    "start=$50.00, end=$45.00",
    "Start: 50.00, End: 45",
    "The answer is start = $50, end = $45.",
  ])("accepts %j", (answer) => {
    expect(scoreTotals(answer)).toBe(true);
  });

  it.each([
    ["swapped", "start=45, end=50"],
    ["one value", "start=50"],
    ["near miss", "start=50, end=45.5"],
    ["prose only", "it went from fifty to forty-five"],
  ])("rejects %s", (_name, answer) => {
    expect(scoreTotals(answer)).toBe(false);
  });
});

describe("scoreImage", () => {
  it("accepts 50 with or without formatting", () => {
    expect(scoreImage("50")).toBe(true);
    expect(scoreImage("$50.00")).toBe(true);
  });

  it("does not accept a number that merely contains 50", () => {
    expect(scoreImage("150")).toBe(false);
    expect(scoreImage("$45.00")).toBe(false);
  });
});

describe("scoreTranscript", () => {
  it("accepts forty-five spoken or written as digits", () => {
    expect(scoreTranscript("drop to forty five dollars")).toBe(true);
    expect(scoreTranscript("drop to Forty-five dollars")).toBe(true);
    expect(scoreTranscript("drop to $45")).toBe(true);
  });

  it("rejects a transcript that missed the amount", () => {
    expect(scoreTranscript("drop to fifty dollars")).toBe(false);
    expect(scoreTranscript("drop to 145")).toBe(false);
  });
});

describe("scoreOk and amounts", () => {
  it("finds OK as a word", () => {
    expect(scoreOk("OK")).toBe(true);
    expect(scoreOk("ok.")).toBe(true);
    expect(scoreOk("token")).toBe(false);
  });

  it("extracts numbers, ignoring currency symbols and thousands separators", () => {
    expect(amounts("$1,250.00 then 45")).toEqual([1250, 45]);
  });
});
