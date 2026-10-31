import { addUsage, NO_USAGE, type ModelPort, type ModelUsage } from "../models/port.ts";
import {
  COVERAGE_JSON_SCHEMA,
  COVERAGE_SYSTEM,
  COVERAGE_V1,
  CoverageReply,
  renderCoverage,
} from "../prompts/coverage.v1.ts";
import type { ContextBundle, CoverageMap, Criterion } from "../schema/index.ts";
import { routeCandidates } from "./routes.ts";

// Coverage (ARCHITECTURE §18): which changed files could implement each criterion, from Spark 1.3
// (coverage.v1; Muse Code is CLI-only, DECISIONS 2026-10-30), plus the routes the changed files
// belong to (routes.ts). Code holds the reply to the diff: a file the diff doesn't change is
// dropped, "covered" needs a file, and a criterion the reply skips is "unclear".

export const COVERAGE_MODEL = "muse-spark-1.3";
const MAX_TOKENS = 8_000;

export interface CoverageResult {
  ok: boolean;
  coverage: CoverageMap;
  problems: string[];
  usage: ModelUsage;
  calls: number;
}

export async function mapCoverage(
  port: ModelPort,
  criteria: readonly Criterion[],
  diff: ContextBundle["diff"],
  options: { model?: string; timeoutMs?: number } = {},
): Promise<CoverageResult> {
  const routes = routeCandidates(diff.files.map((f) => f.path));
  const unclear = (id: string) => ({ criterionId: id, files: [], status: "unclear" as const });
  if (criteria.length === 0) {
    return { ok: true, coverage: { items: [], routes }, problems: [], usage: NO_USAGE, calls: 0 };
  }
  if (diff.files.length === 0) {
    const items = criteria.map((c) => ({ criterionId: c.id, files: [], status: "uncovered" as const }));
    return { ok: true, coverage: { items, routes }, problems: [], usage: NO_USAGE, calls: 0 };
  }

  const result = await port.call({
    stage: "coverage",
    model: options.model ?? COVERAGE_MODEL,
    promptVersion: COVERAGE_V1,
    messages: [
      { role: "system", content: COVERAGE_SYSTEM },
      { role: "user", content: renderCoverage(criteria, diff.files) },
    ],
    schema: CoverageReply,
    jsonSchema: { name: "coverage", schema: COVERAGE_JSON_SCHEMA },
    maxTokens: MAX_TOKENS,
    ...(options.timeoutMs && { timeoutMs: options.timeoutMs }),
  });
  const usage = addUsage(NO_USAGE, result.usage);
  if (!result.ok) {
    return {
      ok: false,
      coverage: { items: criteria.map((c) => unclear(c.id)), routes },
      problems: [`the coverage call failed: ${result.error}`],
      usage,
      calls: 1,
    };
  }

  const changed = new Set(diff.files.map((f) => f.path));
  const problems: string[] = [];
  const items = criteria.map((c) => {
    const item = result.output.items.find((i) => i.criterionId === c.id);
    if (!item) {
      problems.push(`${c.id}: no coverage item in the reply`);
      return unclear(c.id);
    }
    const files = [...new Set(item.files)].filter((f) => changed.has(f));
    const dropped = item.files.filter((f) => !changed.has(f));
    if (dropped.length) problems.push(`${c.id}: not in the diff: ${dropped.join(", ")}`);
    const status = item.status === "covered" && files.length === 0 ? "unclear" : item.status;
    return { criterionId: c.id, files, status };
  });
  return { ok: true, coverage: { items, routes }, problems, usage, calls: 1 };
}
