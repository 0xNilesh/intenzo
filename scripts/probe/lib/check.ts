import { MODELS, REQUIRED, type ProbeResult } from "./results.ts";

/**
 * Lists everything that keeps T0.2 from being done: a required capability with no result, a
 * result without a definite answer, or an `ok` result with no latency. Empty means done.
 */
export function checkResults(results: readonly ProbeResult[]): string[] {
  const problems: string[] = [];
  for (const model of MODELS) {
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
