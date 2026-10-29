// Checks probes/results.json for ROADMAP T0.2: every model has a definite answer (ok or
// unsupported) for every capability, and every ok result has a latency. Exits 1 until it does.
//   pnpm probe:assert
import { existsSync, readFileSync } from "node:fs";

import { checkResults } from "./lib/check.ts";
import { formatResult, RESULTS_FILE } from "./lib/report.ts";
import { MODELS, ProbeResults } from "./lib/results.ts";

if (!existsSync(RESULTS_FILE)) {
  console.error("No probes/results.json yet. Run `pnpm probe:all` first.");
  process.exit(1);
}

const parsed = ProbeResults.safeParse(JSON.parse(readFileSync(RESULTS_FILE, "utf8")));
if (!parsed.success) {
  console.error(`probes/results.json doesn't match the result schema:\n${parsed.error.message}`);
  process.exit(1);
}

const { generatedAt, results } = parsed.data;
for (const model of MODELS) {
  console.log(`\n${model}`);
  for (const result of results.filter((r) => r.model === model)) {
    console.log(`  ${formatResult(result)}`);
  }
}
console.log(`\nResults from ${generatedAt}.`);

// A wrong answer is a finding about model quality, not a missing answer, so it doesn't fail T0.2.
const wrong = results.filter((r) => r.correct === false);
if (wrong.length > 0) {
  console.log(
    `Note: ${wrong.length} answer(s) didn't match the ground truth: ` +
      wrong.map((r) => `${r.model}/${r.capability}`).join(", "),
  );
}

const problems = checkResults(results);
if (problems.length > 0) {
  console.error(
    `\nT0.2 isn't done: ${problems.length} capability check(s) have no definite answer yet:\n` +
      problems.map((p) => `  - ${p}`).join("\n"),
  );
  process.exit(1);
}
console.log(`\nT0.2 done: all ${results.length} capability checks have a definite answer.`);
