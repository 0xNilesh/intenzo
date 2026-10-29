// Runs the model capability probes (ROADMAP T0.2) and merges the results into probes/results.json.
//   pnpm probe:all                    every model
//   pnpm probe:all spark-1.3 wonder   only these models
// Makes real, billed API calls (a few cents per run). Keys come from .env (see .env.example).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { loadDotEnv } from "./lib/env.ts";
import { ensureMedia } from "./lib/media.ts";
import type { Probe, ProbeContext } from "./lib/probe.ts";
import { formatResult, RESULTS_FILE } from "./lib/report.ts";
import {
  MODELS,
  mergeResults,
  ProbeResults,
  type ModelKey,
  type ProbeResult,
} from "./lib/results.ts";
import { probeSparkOpen } from "./models/spark-open.ts";
import { probeSpark } from "./models/spark.ts";
import { probeWonder } from "./models/wonder.ts";

const PROBES: Partial<Record<ModelKey, Probe>> = {
  "spark-1.3": probeSpark,
  "spark-open": probeSparkOpen,
  wonder: probeWonder,
};

const wanted = process.argv.slice(2);
const unknown = wanted.filter((m) => !(MODELS as readonly string[]).includes(m));
if (unknown.length > 0) {
  console.error(`Unknown model(s): ${unknown.join(", ")}. Choose from: ${MODELS.join(", ")}`);
  process.exit(2);
}

loadDotEnv();
const fresh: ProbeResult[] = [];
const ctx: ProbeContext = {
  samples: Number(process.env.PROBE_SAMPLES ?? 5),
  media: ensureMedia(),
  record(result) {
    const stamped = { ...result, at: new Date().toISOString() };
    fresh.push(stamped);
    console.log(`  ${formatResult(stamped)}`);
  },
};

for (const model of MODELS) {
  if (wanted.length > 0 && !wanted.includes(model)) continue;
  const probe = PROBES[model];
  console.log(`\n${model}`);
  if (probe) await probe(ctx);
  else console.log("  (no probe yet)");
}

const existing = existsSync(RESULTS_FILE)
  ? ProbeResults.parse(JSON.parse(readFileSync(RESULTS_FILE, "utf8"))).results
  : [];
mkdirSync(dirname(RESULTS_FILE), { recursive: true });
const results = mergeResults(existing, fresh);
writeFileSync(
  RESULTS_FILE,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`,
);
console.log(`\nWrote ${fresh.length} result(s) to probes/results.json. Next: pnpm probe:assert`);
