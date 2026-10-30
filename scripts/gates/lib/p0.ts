// What the Phase 0 gate requires the decision log and the demo files to say (ROADMAP P0 gate).
// DECISIONS.md entries are dated history that's never edited, so these exact sentences are stable.

export const DEMO_TICKET = { repo: "sumithprabhu/demo-shop", issue: 5 } as const;

export const P0_DECISIONS = [
  { what: "the go/no-go result (T0.3)", pattern: /^## .*Judge go\/no-go: GO/m },
  { what: "the judge mode, Spark Open (T0.2b)", pattern: /Spark Open judges native video/ },
  {
    what: "the judge mode, Spark 1.3 (T0.2)",
    pattern: /Judge video goes inline as an MP4 data URL/,
  },
  {
    what: "where Muse Code runs (T0.2)",
    pattern: /Muse Code runs in muse-fixer as a headless CLI/,
  },
  {
    what: "the Transcribe approach (T0.2)",
    pattern: /Spoken intent uses the file transcription endpoint/,
  },
  { what: "which coverage model is used (T0.2)", pattern: /the coverage check uses Spark 1\.3/ },
  { what: "the inconclusive rule, strict or R13 (T0.3)", pattern: /strict §22\.3 rule stay/ },
] as const;

/** The P0 decisions DECISIONS.md doesn't record yet. */
export function missingDecisions(decisions: string): string[] {
  return P0_DECISIONS.filter((d) => !d.pattern.test(decisions)).map((d) => d.what);
}

/** What the golden comment must cover (ROADMAP T0.7 Verify: C1–C4 + ⚠️, with C2's readings). */
export function missingFromGolden(comment: string): string[] {
  const needs: [string, RegExp][] = [
    ["C1", /\| ✅ \| C1 /],
    ["C2 (failing)", /\| ❌ \| C2 /],
    [
      "C2's readings line",
      /Readings: \+0 s \$50\.00 · \+1 s \$50\.00 · \+3 s \$50\.00 · after reload \$45\.00/,
    ],
    ["C3", /\| ✅ \| C3 /],
    ["C4", /\| ✅ \| C4 /],
    ["the ⚠️ unrequested change", /^⚠️ Unrequested change/m],
  ];
  return needs.filter(([, re]) => !re.test(comment)).map(([what]) => what);
}
