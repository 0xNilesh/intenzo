import { describe, expect, it } from "vitest";

import type { JudgeOutput, Reading } from "../schema/index.ts";
import {
  afterRerecord,
  capVerdict,
  type Checked,
  checkJudge,
  combine,
  type Combined,
  preJudge,
  rerecordFor,
  valueMatches,
} from "./rules.ts";

const reading = (i: number, value: string | null, kind = "text"): Reading =>
  ({ i, label: "order total", kind, phase: "post", tMs: 0, value, bbox: null }) as Reading;

describe("valueMatches (§22.3: tokens, not substrings)", () => {
  it.each([
    ["5.00", "$45.00", false],
    ["45", "$45.00", true],
    ["$45.00", "$45.00", true],
    ["$45", "Total $45.00", true],
    ["$50.00", "Subtotal $50.00\nTotal $45.00", true],
    ["$45.00", "$450.00", false],
    ["$1,045.00", "$1,045.00", true],
    ["−$5.00", "+ text: Subtotal $50.00 Discount (SAVE10) −$5.00 Total $50.00", true],
    ["10", "SAVE10", false],
    ["This code has expired", '+ alert "This code has expired"', true],
    ["This code has expired", "+ alert: This code has expired", true],
    ["this code HAS expired", '+ alert "This code has expired"', true],
    ["code has expired", '+ alert "This code has expired"', false],
    ["no change", "no change", true],
    ["", "$45.00", false],
    [null, "$45.00", false],
    ["$45.00", null, false],
  ])("%j vs %j → %s", (cited, value, expected) => {
    expect(valueMatches(cited, [reading(0, value)])).toBe(expected);
  });
});

const judge = (over: Partial<JudgeOutput> = {}): JudgeOutput => ({
  verdict: "fail",
  targetCorrect: true,
  citedReadings: [1],
  citedValue: "$50.00",
  atMs: null,
  observed: "It stayed $50.00.",
  ...over,
});
const C2 = { watch: ["order total"], kind: "ui_behavior" as const };
const READINGS = [reading(0, "$50.00"), reading(1, "$50.00"), reading(2, "$45.00")];

describe("checkJudge (§22.3)", () => {
  it.each([
    ["a cited, matching value", judge(), { verdict: "fail", reason: null }],
    [
      "a wrong target",
      judge({ targetCorrect: false }),
      { verdict: "inconclusive", reason: "wrong_target" },
    ],
    [
      "a value no cited reading has",
      judge({ citedValue: "$40.00" }),
      { verdict: "inconclusive", reason: "contradicts_readings" },
    ],
    [
      "no citation",
      judge({ citedReadings: [] }),
      { verdict: "inconclusive", reason: "contradicts_readings" },
    ],
    [
      "a reading that doesn't exist",
      judge({ citedReadings: [1, 9] }),
      { verdict: "inconclusive", reason: "contradicts_readings" },
    ],
    [
      "the judge's own inconclusive",
      judge({ verdict: "inconclusive", citedReadings: [] }),
      { verdict: "inconclusive", reason: null },
    ],
  ] as const)("%s", (_case, output, checked) => {
    expect(checkJudge(output, C2, READINGS)).toEqual(checked);
  });

  it("needs no citation for a visual criterion, or one with nothing to watch", () => {
    const bare = judge({ verdict: "pass", citedReadings: [], citedValue: null });
    expect(
      checkJudge(bare, { watch: ["savings chart"], kind: "ui_visual" }, READINGS).verdict,
    ).toBe("pass");
    expect(checkJudge(bare, { watch: [], kind: "ui_behavior" }, READINGS).verdict).toBe("pass");
  });

  it("is infra_error when a judge gave no answer", () => {
    expect(checkJudge(null, C2, READINGS)).toEqual({
      verdict: "inconclusive",
      reason: "infra_error",
    });
  });
});

const ok = (verdict: "pass" | "fail" | "inconclusive"): Checked => ({ verdict, reason: null });
const off = (reason: Checked["reason"]): Checked => ({ verdict: "inconclusive", reason });

describe("combine (§22.3)", () => {
  it.each([
    [ok("pass"), ok("pass"), { verdict: "pass", reason: "agreed" }],
    [ok("fail"), ok("fail"), { verdict: "fail", reason: "agreed" }],
    [ok("pass"), ok("fail"), { verdict: "inconclusive", reason: "judges_disagree" }],
    [ok("pass"), ok("inconclusive"), { verdict: "inconclusive", reason: "judges_disagree" }],
    [ok("fail"), off("wrong_target"), { verdict: "inconclusive", reason: "wrong_target" }],
    [
      off("contradicts_readings"),
      off("wrong_target"),
      { verdict: "inconclusive", reason: "wrong_target" },
    ],
    [off("infra_error"), ok("pass"), { verdict: "inconclusive", reason: "infra_error" }],
    [
      ok("inconclusive"),
      ok("inconclusive"),
      { verdict: "inconclusive", reason: "judges_disagree" },
    ],
  ] as const)("%j + %j → %j", (a, b, combined) => {
    expect(combine(a, b)).toEqual(combined);
  });
});

const agreed = (verdict: "pass" | "fail"): Combined => ({ verdict, reason: "agreed" });
const tie: Combined = { verdict: "inconclusive", reason: "judges_disagree" };

describe("the re-record rule (§19 e)", () => {
  it("records again to confirm a fail, or to break a tie, and not otherwise", () => {
    expect(rerecordFor(agreed("fail"))).toBe("confirm_fail");
    expect(rerecordFor(tie)).toBe("break_tie");
    expect(rerecordFor(agreed("pass"))).toBeNull();
    expect(rerecordFor({ verdict: "inconclusive", reason: "wrong_target" })).toBeNull();
  });

  it("keeps a fail only if the new take fails again: else it's flaky", () => {
    const first = agreed("fail");
    const judges = [ok("fail"), ok("fail")] as const;
    expect(afterRerecord(first, judges, agreed("fail"))).toEqual(agreed("fail"));
    expect(afterRerecord(first, judges, agreed("pass"))).toEqual({
      verdict: "inconclusive",
      reason: "flaky",
    });
    expect(afterRerecord(first, judges, tie)).toEqual({ verdict: "inconclusive", reason: "flaky" });
  });

  it("settles a tie only with a verdict one of the first two judges gave (no judge-shopping)", () => {
    expect(afterRerecord(tie, [ok("pass"), ok("fail")], agreed("fail"))).toEqual(agreed("fail"));
    expect(afterRerecord(tie, [ok("pass"), ok("inconclusive")], agreed("pass"))).toEqual(
      agreed("pass"),
    );
    // Neither first judge said fail: an agreed fail now is shopping for a verdict.
    expect(afterRerecord(tie, [ok("pass"), ok("inconclusive")], agreed("fail"))).toEqual(tie);
    expect(afterRerecord(tie, [ok("pass"), ok("fail")], tie)).toEqual(tie);
  });

  it("leaves any other first result as it was", () => {
    expect(afterRerecord(agreed("pass"), [ok("pass"), ok("pass")], agreed("fail"))).toEqual(
      agreed("pass"),
    );
  });
});

describe("the pre-judge (§22.1)", () => {
  it.each([
    [
      "not_verifiable_in_ui",
      "completed",
      { verdict: "inconclusive", reason: "not_verifiable_in_ui" },
    ],
    ["ui_behavior", "setup_failed", { verdict: "inconclusive", reason: "setup_failed" }],
    [
      "ui_behavior",
      "precondition_unmet",
      { verdict: "inconclusive", reason: "precondition_unmet" },
    ],
    ["ui_behavior", "timeout", { verdict: "inconclusive", reason: "infra_error" }],
    ["ui_behavior", "error", { verdict: "inconclusive", reason: "infra_error" }],
    ["ui_behavior", "completed", null],
    ["ui_behavior", "trigger_absent", null],
  ] as const)("%s with a %s PR lane → %j", (kind, status, expected) => {
    expect(preJudge({ kind }, { status })).toEqual(expected);
  });

  it("is infra_error when the PR side wasn't recorded at all", () => {
    expect(preJudge({ kind: "ui_behavior" }, null)).toEqual({
      verdict: "inconclusive",
      reason: "infra_error",
    });
  });
});

describe("the caps (§22.1)", () => {
  const isolated = { status: "completed", isolation: "ephemeral_user" } as const;
  const absent = { status: "trigger_absent", isolation: "ephemeral_user" } as const;

  it("never lets a missing trigger pass", () => {
    expect(capVerdict(agreed("pass"), absent, "covered")).toEqual({
      verdict: "inconclusive",
      reason: "precondition_unmet",
    });
  });

  it("fails a missing trigger only when the PR touches the criterion", () => {
    expect(capVerdict(agreed("fail"), absent, "covered")).toEqual(agreed("fail"));
    expect(capVerdict(agreed("fail"), absent, "unclear")).toEqual(agreed("fail"));
    expect(capVerdict(agreed("fail"), absent, "uncovered")).toEqual({
      verdict: "inconclusive",
      reason: "precondition_unmet",
    });
  });

  it("caps a lane without isolation at inconclusive", () => {
    const shared = { status: "completed", isolation: "none" } as const;
    expect(capVerdict(agreed("pass"), shared)).toEqual({
      verdict: "inconclusive",
      reason: "no_isolation",
    });
    expect(capVerdict(agreed("fail"), shared)).toEqual({
      verdict: "inconclusive",
      reason: "no_isolation",
    });
  });

  it("leaves an isolated, triggered verdict alone", () => {
    expect(capVerdict(agreed("pass"), isolated, "covered")).toEqual(agreed("pass"));
    expect(capVerdict(tie, isolated)).toEqual(tie);
  });
});
