import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { chromium } from "playwright";

import {
  Criterion,
  formatProblems,
  isolationLevel,
  parseConfig,
  readConfig,
  SavedPath,
  type IntenzoConfig,
  type Reading,
} from "@intenzo/core";
import { recordCriterion, type RecordOptions, type Recording } from "@intenzo/core/browser";

// `intenzo record`: records one hand-written SavedPath on the PR app and, optionally, the base
// app, with the observation protocol (ARCHITECTURE §21.3), and prints each side's readings.
//
//   pnpm intenzo record --path fixtures/paths/C2.json --pr http://localhost:3001 \
//                       [--base http://localhost:3000] [--criterion <Criterion.json>] \
//                       [--out <dir>] [--config <.intenzo.yml or repo dir>] [--hook-secret-env NAME]
//
// The session hook's path comes from the config; its secret from the environment (.env), under
// the name --hook-secret-env gives (the config only ever names secrets, never holds them).

const REPO = resolve(import.meta.dirname, "../../..");
const DEFAULT_CONFIG = "packages/core/fixtures/config/demo-shop.intenzo.yml";
const DEFAULT_HOOK_SECRET_ENV = "DEMO_SHOP_HOOK_SECRET";
const DEFAULT_BYPASS_ENV = "DEMO_SHOP_BYPASS_SECRET";

export const RECORD_USAGE = `Usage: pnpm intenzo record --path <SavedPath.json> --pr <url> [--base <url>]
         [--criterion <Criterion.json>] [--out <dir>] [--config <.intenzo.yml>]
         [--hook-secret-env <NAME>] [--bypass-env <NAME>]

  --criterion        default: fixtures/criteria/<the path's criterion id>.json
  --out              the run root; each take goes in <out>/<criterion>/<side>/take-1
                     (default: out/runs/local-<UTC time>)
  --config           .intenzo.yml, or a repo dir holding one
                     (default: packages/core/fixtures/config/demo-shop.intenzo.yml)
  --hook-secret-env  env var holding the session hook's secret (default: DEMO_SHOP_HOOK_SECRET)
  --bypass-env       env var holding Vercel's protection bypass, used for non-local apps
                     (default: DEMO_SHOP_BYPASS_SECRET)`;

export class UsageError extends Error {}

export interface RecordArgs {
  path: string;
  pr: string;
  base?: string;
  criterion?: string;
  out?: string;
  config: string;
  hookSecretEnv: string;
  bypassEnv: string;
}

export function parseRecordArgs(argv: readonly string[]): RecordArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        path: { type: "string" },
        pr: { type: "string" },
        base: { type: "string" },
        criterion: { type: "string" },
        out: { type: "string" },
        config: { type: "string" },
        "hook-secret-env": { type: "string" },
        "bypass-env": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  if (!values.path) throw new UsageError("--path is required");
  if (!values.pr) throw new UsageError("--pr is required");
  for (const [flag, url] of [
    ["--pr", values.pr],
    ["--base", values.base],
  ] as const) {
    if (url !== undefined && !URL.canParse(url)) throw new UsageError(`${flag} must be a URL`);
  }
  return {
    path: values.path,
    pr: values.pr,
    ...(values.base && { base: values.base }),
    ...(values.criterion && { criterion: values.criterion }),
    ...(values.out && { out: values.out }),
    config: values.config ?? DEFAULT_CONFIG,
    hookSecretEnv: values["hook-secret-env"] ?? DEFAULT_HOOK_SECRET_ENV,
    bypassEnv: values["bypass-env"] ?? DEFAULT_BYPASS_ENV,
  };
}

/** `out/runs/local-20261030-231500`: a local run's root. Each take goes under {criterion}/{side}. */
export function localRunDir(at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return join("out", "runs", `local-${stamp}`);
}

const seconds = (ms: number) => `${ms < 0 ? "−" : "+"}${(Math.abs(ms) / 1000).toFixed(2)} s`;

function cell(value: string | null, width: number): string {
  const flat = value === null ? "—" : value.split("\n").join(" ⏎ ") || '""';
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

/** A compact summary of one side's recording: status, alignment, then one line per reading. */
export function formatRecording(side: string, origin: string, recording: Recording): string {
  const { lane } = recording;
  const tt = lane.tTriggerMs;
  const lines = [`${side.toUpperCase()} ${origin} · ${lane.status} · isolation ${lane.isolation}`];
  if (lane.failedStepIndex !== undefined) {
    const failed = lane.stepLog[lane.failedStepIndex]!;
    lines.push(`  step ${lane.failedStepIndex} (${failed.step.op}) failed: ${failed.error ?? ""}`);
  } else if (recording.error) {
    lines.push(`  ${recording.error}`);
  }
  lines.push(`  alignment ${formatAlignment(recording)}`);
  const origin0 = tt ?? lane.laneStartMs;
  lines.push(`  ${tt === null ? "t from lane start (no Tt)" : "t from Tt"}`);
  const width = Math.max(5, ...lane.readings.map((r) => r.label.length));
  lines.push(
    `  ${"label".padEnd(width)}  ${"phase".padEnd(12)}  ${"t".padStart(8)}  kind         value`,
  );
  for (const r of lane.readings) lines.push(`  ${row(r, width, origin0)}`);
  lines.push(
    `  console errors ${lane.consoleErrorCount} · failed requests ${lane.failedRequestCount} (trigger window)`,
  );
  return lines.join("\n");
}

/** "ok (marker): the marker is at 0.85 s in raw.webm": where canonical time lands in the video. */
function formatAlignment({ alignment, markerShownAt }: Recording): string {
  if (alignment.status !== "ok") return `${alignment.status}: ${alignment.reason}`;
  const offset = `offset ${Math.round(alignment.offsetMs)} ms`;
  if (markerShownAt === null) return `ok (${alignment.method}): ${offset}`;
  const at = ((markerShownAt + alignment.offsetMs) / 1000).toFixed(2);
  return `ok (${alignment.method}): the marker is at ${at} s in raw.webm (${offset})`;
}

function row(r: Reading, width: number, origin: number): string {
  return [
    r.label.padEnd(width),
    r.phase.padEnd(12),
    seconds(r.tMs - origin).padStart(8),
    r.kind.padEnd(11),
    cell(r.value, 70),
  ].join("  ");
}

function loadConfig(path: string): IntenzoConfig {
  if (!existsSync(path)) throw new UsageError(`no config at ${path}`);
  const isDir = statSync(path).isDirectory();
  const { file, result } = isDir
    ? readConfig(path)
    : { file: path, result: parseConfig(readFileSync(path, "utf8")) };
  if (!result.ok) throw new UsageError(formatProblems(file ?? path, result.problems));
  return result.config;
}

interface Schema<T> {
  safeParse(
    data: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

/** Reads and validates a JSON file, with a readable error for the CLI. */
function readJson<T>(schema: Schema<T>, path: string): T {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new UsageError(`can't read ${path}: ${(err as Error).message}`);
  }
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`,
  );
  throw new UsageError(`${path} isn't valid:\n${problems.join("\n")}`);
}

const isLocal = (origin: string) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);

/** Runs `intenzo record`. Returns the exit code. */
export async function runRecord(argv: readonly string[]): Promise<number> {
  const args = parseRecordArgs(argv);
  const cwd = process.env.INIT_CWD ?? process.cwd(); // where the user ran pnpm
  const fromUser = (p: string) => resolve(cwd, p);
  if (existsSync(join(REPO, ".env"))) process.loadEnvFile(join(REPO, ".env"));

  const path = readJson(SavedPath, fromUser(args.path));
  const criterionFile = args.criterion
    ? fromUser(args.criterion)
    : join(REPO, "fixtures", "criteria", `${path.criterionId}.json`);
  const criterion = readJson(Criterion, criterionFile);
  if (criterion.id !== path.criterionId) {
    throw new UsageError(
      `the path is for ${path.criterionId}, but ${criterionFile} is ${criterion.id}`,
    );
  }
  const configFile =
    args.config === DEFAULT_CONFIG ? join(REPO, DEFAULT_CONFIG) : fromUser(args.config);
  const config = loadConfig(configFile);

  let identity: RecordOptions["identity"];
  const level = isolationLevel(config);
  if (level === "ephemeral_user") {
    const secret = process.env[args.hookSecretEnv];
    if (!secret) {
      throw new UsageError(
        `the config has a session hook, but ${args.hookSecretEnv} isn't set (add it to .env)`,
      );
    }
    identity = { hookPath: config.isolation.session_hook!, secret };
  }
  const bypass = process.env[args.bypassEnv];
  const runRoot = args.out ? fromUser(args.out) : join(REPO, localRunDir(new Date()));

  console.log(`intenzo record ${criterion.id} · ${relative(cwd, runRoot) || "."}`);
  console.log(
    `isolation ${identity ? "ephemeral_user (session hook)" : `none (config isolation: ${level})`}`,
  );
  const sides = [["pr", args.pr], ...(args.base ? [["base", args.base] as const] : [])] as const;
  const browser = await chromium.launch();
  let failed = false;
  try {
    for (const [side, origin] of sides) {
      const outDir = join(runRoot, criterion.id, side, "take-1");
      const recording = await recordCriterion(browser, {
        origin,
        side,
        criterion,
        path,
        outDir,
        ...(identity && { identity }),
        // The bypass is only for protected deployments; a local app never needs it.
        ...(bypass && !isLocal(origin) && { bypass }),
      });
      console.log(`\n${formatRecording(side, origin, recording)}`);
      console.log(`  take: ${relative(cwd, outDir)}`);
      if (recording.lane.status === "error" || recording.alignment.status !== "ok") failed = true;
    }
  } finally {
    await browser.close();
  }
  return failed ? 1 : 0;
}
