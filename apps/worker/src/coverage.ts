import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { ContextBundle, Criterion, CriterionSet } from "@intenzo/core";
import { COVERAGE_MODEL, mapCoverage } from "@intenzo/core/coverage";
import { costUsd, metaModelPort } from "@intenzo/core/models";

import { REPO, UsageError } from "./record.ts";

// `intenzo coverage`: which of a PR's changed files implement each criterion (coverage.v1,
// ARCHITECTURE §18), with the routes the changed files belong to. One Spark 1.3 call.
//
//   pnpm intenzo coverage --criteria fixtures/criteria --diff <diff.json>

export const COVERAGE_USAGE = `Usage: pnpm intenzo coverage --criteria <dir or CriterionSet.json> --diff <diff.json> [--model <id>]

  --criteria  a folder of Criterion JSON files (C1.json…), or a CriterionSet (intenzo intent --out)
  --diff      the PR's diff as a ContextBundle diff: {"files": [{"path", "status", "additions",
              "deletions", "patch"}]}
  One Spark 1.3 call; needs META_API_KEY in .env.`;

export function parseCoverageArgs(argv: readonly string[]) {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        criteria: { type: "string" },
        diff: { type: "string" },
        model: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  if (!values.criteria) throw new UsageError("--criteria is required");
  if (!values.diff) throw new UsageError("--diff is required");
  return { criteria: values.criteria, diff: values.diff, model: values.model ?? COVERAGE_MODEL };
}

/** Criteria from a folder of Criterion files, or from a CriterionSet file. */
export function readCriteria(path: string): Criterion[] {
  if (!existsSync(path)) throw new UsageError(`nothing at ${path}`);
  if (statSync(path).isDirectory()) {
    return readdirSync(path)
      .filter((f) => /^C\d+\.json$/.test(f))
      .sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)))
      .map((f) => Criterion.parse(JSON.parse(readFileSync(join(path, f), "utf8"))));
  }
  return CriterionSet.parse(JSON.parse(readFileSync(path, "utf8"))).criteria;
}

export async function runCoverage(argv: readonly string[]): Promise<number> {
  const args = parseCoverageArgs(argv);
  const cwd = process.env.INIT_CWD ?? process.cwd();
  if (existsSync(join(REPO, ".env"))) process.loadEnvFile(join(REPO, ".env"));
  const apiKey = process.env.META_API_KEY ?? process.env.MODEL_API_KEY;
  if (!apiKey) throw new UsageError("META_API_KEY isn't set (add it to .env)");

  const criteria = readCriteria(resolve(cwd, args.criteria));
  const diff = ContextBundle.shape.diff.parse(
    JSON.parse(readFileSync(resolve(cwd, args.diff), "utf8")),
  );
  console.log(
    `intenzo coverage · ${criteria.length} criteria · ${diff.files.length} changed files · ${args.model}`,
  );
  const result = await mapCoverage(metaModelPort({ apiKey }), criteria, diff, {
    model: args.model,
  });
  for (const item of result.coverage.items) {
    const text = criteria.find((c) => c.id === item.criterionId)?.text ?? "";
    console.log(`\n${item.criterionId} ${item.status.padEnd(9)} ${text}`);
    for (const f of item.files) console.log(`   ${f}`);
  }
  console.log(`\nroutes: ${result.coverage.routes.join(", ") || "none"}`);
  for (const p of result.problems) console.log(`✗ ${p}`);
  const cost = costUsd(args.model, result.usage);
  console.log(
    `${result.calls} call · ${result.usage.promptTokens} in / ${result.usage.completionTokens} out tokens · ${cost === null ? "cost unknown" : `$${cost.toFixed(4)}`}`,
  );
  return result.ok ? 0 : 1;
}
