import { MODELS, REQUIRED, type ModelKey, type ProbeResult } from "./results.ts";

/**
 * Lists everything that keeps T0.2 from being done: a required capability with no result, a
 * result without a definite answer, or an `ok` result with no latency. Empty means done.
 * `models` limits the check to some models (T0.2 checks the Meta models, T0.2b Spark Open).
 */
export function checkResults(
  results: readonly ProbeResult[],
  models: readonly ModelKey[] = MODELS,
): string[] {
  const problems: string[] = [];
  for (const model of models) {
    for (const capability of REQUIRED[model]) {
      const result = results.find((r) => r.model === model && r.capability === capability);
      if (!result) {
        problems.push(`${model}/${capability}: no result yet`);
      } else if (result.status === "error") {
        problems.push(`${model}/${capability}: no definite answer (${result.error ?? "error"})`);
      } else if (result.status === "ok" && result.latencyMs === null) {
        problems.push(`${model}/${capability}: ok but no latency recorded`);
      }
    }
  }
  return problems;
}
