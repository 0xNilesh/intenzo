// The stub verdicts (ROADMAP T2.7): until the judges arrive (P4), a job reports the demo ticket's
// criteria (fixtures/criteria) with fixed verdicts, as the almost-right branch earns them: C2
// fails, the rest pass. Every verdict names "stub" as its judge, so the report says so.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  aggregate,
  Criterion,
  CriterionSet,
  type RunOutcome,
  type Verdict,
  type VerdictValue,
} from "@intenzo/core";

const CRITERIA_DIR = new URL("../../../../fixtures/criteria/", import.meta.url);
const STUB_VERDICTS: Record<string, VerdictValue> = {
  C1: "pass",
  C2: "fail",
  C3: "pass",
  C4: "pass",
};

export function stubIntent(): CriterionSet {
  const criteria = Object.keys(STUB_VERDICTS).map((id) =>
    Criterion.parse(JSON.parse(readFileSync(new URL(`${id}.json`, CRITERIA_DIR), "utf8"))),
  );
  const ticketHash = createHash("sha256").update(JSON.stringify(criteria)).digest("hex");
  return CriterionSet.parse({ criteria, intentSource: "linked_issue", ticketHash });
}

export function stubVerdict(criterionId: string): Verdict {
  const verdict = STUB_VERDICTS[criterionId] ?? "inconclusive";
  const observed = "Stub verdict: fixed until the judges arrive (P4).";
  const judge = {
    model: "stub",
    verdict,
    targetCorrect: true,
    citedReadings: [],
    citedValue: null,
    atMs: null,
    observed,
  };
  return {
    criterionId,
    verdict,
    reasonCode: verdict === "inconclusive" ? "infra_error" : "agreed",
    evidenceWindow: null,
    observed,
    judges: [judge, judge],
  };
}

export function stubOutcome(verdicts: readonly Verdict[]): RunOutcome {
  return aggregate(verdicts.map((v) => v.verdict)) ?? "inconclusive";
}
