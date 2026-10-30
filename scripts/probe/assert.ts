// Checks probes/results.json: every model has a definite answer (ok or unsupported) for every
// capability, and every ok result has a latency. Exits 1 until it does.
//   pnpm probe:assert                                              every model
//   pnpm probe:assert spark-1.3 wonder muse-code sam-3.1 voice-transcribe   T0.2 (Meta models)
//   pnpm probe:assert spark-open                                   T0.2b
import { existsSync, readFileSync } from "node:fs";

import { checkResults } from "./lib/check.ts";
import { formatResult, RESULTS_FILE } from "./lib/report.ts";
import { MODELS, ProbeResults, type ModelKey } from "./lib/results.ts";

const args = process.argv.slice(2);
const unknown = args.filter((m) => !(MODELS as readonly string[]).includes(m));
if (unknown.length > 0) {
  console.error(`Unknown model(s): ${unknown.join(", ")}. Choose from: ${MODELS.join(", ")}`);
  process.exit(2);
}
const models = (args.length > 0 ? args : MODELS) as readonly ModelKey[];

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
for (const model of models) {
  console.log(`\n${model}`);
  for (const result of results.filter((r) => r.model === model)) {
    console.log(`  ${formatResult(result)}`);
  }
}
console.log(`\nResults from ${generatedAt}.`);

// A wrong answer is a finding about model quality, not a missing answer, so it doesn't fail T0.2.
const wrong = results.filter((r) => models.includes(r.model) && r.correct === false);
if (wrong.length > 0) {
  console.log(
    `Note: ${wrong.length} answer(s) didn't match the ground truth: ` +
      wrong.map((r) => `${r.model}/${r.capability}`).join(", "),
  );
}

const problems = checkResults(results, models);
if (problems.length > 0) {
  console.error(
    `\nNot done: ${problems.length} capability check(s) have no definite answer yet:\n` +
      problems.map((p) => `  - ${p}`).join("\n"),
  );
  process.exit(1);
}
const checked = results.filter((r) => models.includes(r.model)).length;
console.log(
  `\nDone: all ${checked} capability checks for ${models.join(", ")} have a definite answer.`,
);
