// The Phase 6 gate (ROADMAP P6, #52): IntentBench's results, ready for the proof slide.
//   pnpm gate:p6
// Like every gate it runs `pnpm check:all` first, then the analysis tests (`pnpm test:analysis`,
// which need bench/analysis/.venv). Then:
//   - bench/results/judge-heldout.json has every held-out criterion for all 4 arms (arm D with
//     both judges and each alone), each with 2 or more repeats for a spread, and wasn't capped
//   - bench/results/ holds the charts: rates.png, accuracy.png and cost.png
//   - the README's IntentBench section has a row per arm and the small-n caveat
// Prints the results table. No model calls; nothing is created.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "../probe/lib/env.ts";
import { isPng, readmeProblems, resultsProblems, type ResultsFile } from "./lib/p6.ts";

const BENCH = join(REPO_ROOT, "bench/intentbench");
const RESULTS = join(REPO_ROOT, "bench/results");
const CHARTS = ["rates.png", "accuracy.png", "cost.png"];

let failed = false;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failed = true;
  console.log(`${ok ? "✓" : "✗"} ${name}: ${detail}`);
};
const run = (command: string, args: string[]) => {
  const r = spawnSync(command, args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

// 1. Every test.
const all = run("pnpm", ["check:all"]);
const runs = all.out.match(/Tests +\d+ passed/g)?.length ?? 0;
check("pnpm check:all", all.ok, all.ok ? `${runs} test runs passed` : "failed");
if (!all.ok) {
  console.log(all.out.slice(-3000));
  process.exit(1);
}
const venv = existsSync(join(REPO_ROOT, "bench/analysis/.venv/bin/python"));
const analysis = venv ? run("pnpm", ["test:analysis"]) : { ok: false, out: "" };
check(
  "pnpm test:analysis",
  analysis.ok,
  venv
    ? (analysis.out.match(/\d+ passed[^\n]*/)?.[0] ?? "failed")
    : "needs bench/analysis/.venv (bench/analysis/README.md)",
);

// 2. The held-out results.
const criteria = readdirSync(join(BENCH, "cases"))
  .filter((f) => f.endsWith(".json"))
  .map(
    (f) =>
      JSON.parse(readFileSync(join(BENCH, "cases", f), "utf8")) as {
        id: string;
        split: string;
        labels: Record<string, string>;
      },
  )
  .filter((c) => c.split === "heldout")
  .flatMap((c) => Object.keys(c.labels).map((criterionId) => ({ caseId: c.id, criterionId })));
const file = join(RESULTS, "judge-heldout.json");
if (existsSync(file)) {
  const results = JSON.parse(readFileSync(file, "utf8")) as ResultsFile & {
    totals: { usd: number };
  };
  const problems = resultsProblems(results, criteria);
  check(
    "held-out results",
    problems.length === 0,
    problems.length === 0
      ? `${results.rows.length} rows: ${criteria.length} criteria × arms A–D, 2+ repeats; $${results.totals.usd.toFixed(3)}`
      : problems.join("; "),
  );
} else {
  check(
    "held-out results",
    false,
    "no bench/results/judge-heldout.json (pnpm bench:judge --split=heldout)",
  );
}

// 3. The charts.
const charts = CHARTS.filter(
  (c) => existsSync(join(RESULTS, c)) && isPng(readFileSync(join(RESULTS, c))),
);
check(
  "charts",
  charts.length === CHARTS.length,
  `${charts.length}/${CHARTS.length} in bench/results/ (${CHARTS.join(", ")})`,
);

// 4. The README's table.
const readme = readmeProblems(readFileSync(join(REPO_ROOT, "README.md"), "utf8"));
check(
  "README table",
  readme.length === 0,
  readme.length === 0 ? "a row per arm, and the small-n caveat" : readme.join("; "),
);

if (venv) {
  const table = run(join(REPO_ROOT, "bench/analysis/.venv/bin/python"), [
    join(REPO_ROOT, "bench/analysis/metrics.py"),
    file,
  ]);
  if (table.ok) console.log(`\n${table.out.trim()}`);
}
console.log(`\nPHASE 6 GATE: ${failed ? "FAIL" : "PASS"}`);
process.exit(failed ? 1 : 0);
