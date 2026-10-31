import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { chromium } from "playwright";

import { Criterion, denyText, isolationLevel } from "@intenzo/core";
import { metaModelPort } from "@intenzo/core/models";
import { explore, NAVIGATOR_MODEL, type ExploreResult } from "@intenzo/core/navigator";

import {
  DEFAULT_BYPASS_ENV,
  DEFAULT_CONFIG,
  DEFAULT_HOOK_SECRET_ENV,
  isLocal,
  loadConfig,
  readJson,
  REPO,
  UsageError,
} from "./record.ts";

// `intenzo explore`: lets the navigator (ARCHITECTURE §20.3) find its own way to one criterion's
// trigger on the PR app, and saves the SavedPath it leaves behind. It calls Wonder once per step
// (about $0.001–0.005 a step), so it needs META_API_KEY.
//
//   pnpm intenzo explore --criterion fixtures/criteria/C2.json --pr http://localhost:3001 \
//                        [--out <SavedPath.json>] [--config <.intenzo.yml>] [--steps 25]

export const EXPLORE_USAGE = `Usage: pnpm intenzo explore --criterion <Criterion.json> --pr <url>
         [--out <SavedPath.json>] [--config <.intenzo.yml>] [--steps <n>] [--model <id>]
         [--hook-secret-env <NAME>] [--bypass-env <NAME>]

  --out              where to write the saved path (default: out/paths/<criterion>.json)
  --steps            the step budget (default: 25; the time budget is 120 s)
  --model            the navigator model (default: ${NAVIGATOR_MODEL})
  Costs one Wonder call per step; needs META_API_KEY in .env.`;

export interface ExploreArgs {
  criterion: string;
  pr: string;
  out?: string;
  config: string;
  steps: number;
  model: string;
  hookSecretEnv: string;
  bypassEnv: string;
}

export function parseExploreArgs(argv: readonly string[]): ExploreArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        criterion: { type: "string" },
        pr: { type: "string" },
        out: { type: "string" },
        config: { type: "string" },
        steps: { type: "string" },
        model: { type: "string" },
        "hook-secret-env": { type: "string" },
        "bypass-env": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  if (!values.criterion) throw new UsageError("--criterion is required");
  if (!values.pr) throw new UsageError("--pr is required");
  if (!URL.canParse(values.pr)) throw new UsageError("--pr must be a URL");
  const steps = values.steps === undefined ? 25 : Number(values.steps);
  if (!Number.isInteger(steps) || steps < 1 || steps > 50) {
    throw new UsageError("--steps must be a whole number from 1 to 50");
  }
  return {
    criterion: values.criterion,
    pr: values.pr,
    ...(values.out && { out: values.out }),
    config: values.config ?? DEFAULT_CONFIG,
    steps,
    model: values.model ?? NAVIGATOR_MODEL,
    hookSecretEnv: values["hook-secret-env"] ?? DEFAULT_HOOK_SECRET_ENV,
    bypassEnv: values["bypass-env"] ?? DEFAULT_BYPASS_ENV,
  };
}

/** One line per explore step, then the outcome. */
export function formatExplore(result: ExploreResult): string {
  const lines = result.steps.map(
    (s) => `  ${String(s.n).padStart(2)}. ${s.ok ? "ok " : "err"} ${s.result}`,
  );
  const tokens = result.usage.promptTokens + result.usage.completionTokens;
  lines.push(
    `${result.status}${result.status === "found" ? "" : `: ${result.reason}`} · ${result.steps.length} steps · ` +
      `${(result.ms / 1000).toFixed(1)} s · ${result.modelCalls} model calls · ${tokens} tokens ` +
      `(${result.usage.promptTokens} in, ${result.usage.completionTokens} out, ${result.usage.reasoningTokens} reasoning)`,
  );
  return lines.join("\n");
}

/** Runs `intenzo explore`. Returns the exit code: 0 when a path was found. */
export async function runExplore(argv: readonly string[]): Promise<number> {
  const args = parseExploreArgs(argv);
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const fromUser = (p: string) => resolve(cwd, p);
  if (existsSync(join(REPO, ".env"))) process.loadEnvFile(join(REPO, ".env"));
  const apiKey = process.env.META_API_KEY ?? process.env.MODEL_API_KEY;
  if (!apiKey) throw new UsageError("META_API_KEY isn't set (add it to .env)");

  const criterion = readJson(Criterion, fromUser(args.criterion));
  const configFile =
    args.config === DEFAULT_CONFIG ? join(REPO, DEFAULT_CONFIG) : fromUser(args.config);
  const config = loadConfig(configFile);
  let identity: { hookPath: string; secret: string } | undefined;
  if (isolationLevel(config) === "ephemeral_user") {
    const secret = process.env[args.hookSecretEnv];
    if (!secret)
      throw new UsageError(
        `the config has a session hook, but ${args.hookSecretEnv} isn't set (add it to .env)`,
      );
    identity = { hookPath: config.isolation.session_hook!, secret };
  }
  const bypass = process.env[args.bypassEnv];
  const out = args.out ? fromUser(args.out) : join(REPO, "out", "paths", `${criterion.id}.json`);

  console.log(
    `intenzo explore ${criterion.id} on ${args.pr} · ${args.model} · start ${config.start.default}`,
  );
  const browser = await chromium.launch();
  let result: ExploreResult;
  try {
    result = await explore(browser, {
      origin: args.pr,
      criterion,
      model: metaModelPort({ apiKey }),
      modelId: args.model,
      denyText: denyText(config),
      allowedNavigationOrigins: config.guardrails.extra_navigation_origins,
      startPath: config.start.default,
      budget: { steps: args.steps, ms: 120_000 },
      data: config.data,
      ...(identity && { identity }),
      ...(bypass && !isLocal(args.pr) && { bypass }),
      log: (line) => console.log(`  ${line}`),
    });
  } finally {
    await browser.close();
  }
  console.log(`\n${formatExplore(result)}`);
  if (result.status !== "found") return 1;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result.path, null, 2)}\n`);
  console.log(`saved path: ${relative(cwd, out)}\n${JSON.stringify(result.path, null, 2)}`);
  return 0;
}
