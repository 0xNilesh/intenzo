import { REPO_ROOT } from "./env.ts";
import type { ProbeResult } from "./results.ts";

export const RESULTS_FILE = `${REPO_ROOT}probes/results.json`;

const ICON = { ok: "✓", unsupported: "∅", error: "✗" } as const;

/** One console line per result: status, latency, whether the answer was right, and why. */
export function formatResult(r: ProbeResult): string {
  const parts = [`${ICON[r.status]} ${r.model}/${r.capability}`, r.status];
  if (r.latencyMs) parts.push(`p50 ${r.latencyMs.p50} ms`);
  if (r.correct !== null) parts.push(r.correct ? "answer correct" : "answer WRONG");
  const detail = r.error ?? r.notes;
  if (detail) parts.push(detail.length > 160 ? `${detail.slice(0, 160)}…` : detail);
  return parts.join("  ·  ");
}
