import { describe, expect, it } from "vitest";

import type { Label } from "../clips.ts";
import { combine, combineR13, type Checked } from "./combine.ts";
import { formatTable, judgeCell, summarize, type ClipResult, type JudgeResult } from "./report.ts";
import type { VerdictValue } from "./schema.ts";

const judge = (
  name: string,
  said: VerdictValue | null,
  checked: Checked = { verdict: said ?? "inconclusive", reason: said ? null : "infra_error" },
  ms = 8000,
): JudgeResult => ({
  key: name.startsWith("A") ? "spark-open" : "spark-1.3",
  name,
  output:
    said === null
      ? null
      : {
          verdict: said,
          targetCorrect: true,
          citedReadings: [2],
          citedValue: "$50.00",
          atMs: 1000,
          observed: "…",
        },
  checked,
  ms,
  requests: 1,
  usage: { promptTokens: 3000, cachedTokens: 0, completionTokens: 1000, reasoningTokens: 900 },
  costUsd: 0.008,
  cached: false,
});

function clip(id: string, label: Label, a: JudgeResult, b: JudgeResult): ClipResult {
  return {
    id,
    label,
    truth: "",
    judges: [a, b],
    final: combine(a.checked, b.checked),
    r13: combineR13(a.checked, b.checked),
    verdictMs: Math.max(a.ms, b.ms),
  };
}

const RESULTS = [
  clip("total-correct", "pass", judge("A · Spark Open", "pass"), judge("B · Spark 1.3", "pass")),
  clip(
    "total-stale",
    "fail",
    judge("A · Spark Open", "fail"),
    judge(
      "B · Spark 1.3",
      "fail",
      { verdict: "inconclusive", reason: "contradicts_readings" },
      12_000,
    ),
  ),
  clip("confirm-quiet", "ambiguous", judge("A · Spark Open", "pass"), judge("B · Spark 1.3", null)),
];

describe("judgeCell", () => {
  it("shows the answer, and what the §22.3 checks made of it", () => {
    expect(judgeCell(RESULTS[0]!.judges[0])).toBe("pass");
    expect(judgeCell(RESULTS[1]!.judges[1])).toBe("fail→✗cite");
    expect(judgeCell(judge("A", "pass", { verdict: "inconclusive", reason: "wrong_target" }))).toBe(
      "pass→✗target",
    );
    expect(judgeCell(RESULTS[2]!.judges[1])).toBe("error");
  });
});

describe("formatTable", () => {
  it("prints one row per clip with both judges, the final verdict and its time", () => {
    const [head, ...rows] = formatTable(RESULTS);
    expect(head).toMatch(/^clip +truth +A · Spark Open +B · Spark 1\.3 +final +time$/);
    expect(rows[0]).toMatch(/^total-correct +pass +pass +pass +pass \(agreed\) ✓ +8\.0 s$/);
    expect(rows[1]).toMatch(
      /^total-stale +fail +fail +fail→✗cite +inconclusive \(contradicts_readings\) +12\.0 s$/,
    );
    expect(rows[2]).toMatch(/^confirm-quiet +ambiguous +pass +error +inconclusive \(infra_error\)/);
  });
});

describe("summarize", () => {
  it("scores the strict rule, each judge alone and the R13 what-if", () => {
    const s = summarize(RESULTS);
    expect(s.strict).toMatchObject({ correct: 1, decided: 1, inconclusive: 1, clear: 2 });
    expect(s.go).toBe(false); // 1 of 2 clear clips inconclusive = 50%
    expect(s.judges["A · Spark Open"]).toMatchObject({ correct: 2, decided: 2 });
    expect(s.judges["B · Spark 1.3"]).toMatchObject({ correct: 1, inconclusive: 1 });
    expect(s.r13).toMatchObject({ correct: 1, decided: 1 }); // a fail still needs both judges
    expect(s.lines).toContain("    ambiguous clips: confirm-quiet → inconclusive");
    expect(s.lines.some((l) => l.startsWith("  ✗ inconclusive on clear clips: 1/2 = 50%"))).toBe(
      true,
    );
  });
});
