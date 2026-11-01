// pnpm bench:judge [--split heldout|tuning] [--arms A,B,C,D] [--repeats 3] [--only <case>[/<C>]]
//                  [--concurrency 4] [--max-usd 6] [--max-open-usd 0.6] [--fresh] [--dry-run]
// IntentBench's "judge many" (§31, T6.3): every arm judges the packs T6.2 recorded, and the
// verdicts and calls go to bench/results/judge-<split>.json, which is committed (an --only run's
// go to bench/results/raw/, which isn't). A rerun judges only what's missing. Spark 1.3 calls
// cost Meta credit (every arm) and Spark Open's cost Baseten credit (arm D): --dry-run counts the
// calls first. Needs META_API_KEY (and BASETEN_API_KEY for arm D) in .env, the packs in
// bench/intentbench/packs/ as manifest.json lists them, and ffmpeg for arm C's stills.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  type Judge,
  JUDGE_V1,
  judgesFromEnv,
  SPARK_13_MODEL,
  SPARK_OPEN_MODEL,
} from "@intenzo/core/judge";
import { metaModelPort } from "@intenzo/core/models";

import { ARM_JUDGES, ARMS, type Arm, type JudgeName } from "./arms.ts";
import { loadCases, loadTicket } from "./case.ts";
import { STILLS_FPS } from "./frames.ts";
import { type BenchItem, judgeAll } from "./judging.ts";
import { folderHash, MANIFEST_FILE, PACKS_DIR, packDir, readDiff, readPack } from "./pack.ts";
import {
  BenchResults,
  formatResults,
  itemKey,
  readResults,
  RESULTS_DIR,
  stillCurrent,
  tally,
} from "./results.ts";
import { REVIEW_V1 } from "./review.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
process.loadEnvFile(`${ROOT}.env`);
const argv = process.argv.slice(2);
/** `--name value` or `--name=value`. */
function arg(name: string): string | undefined {
  for (const [k, a] of argv.entries()) {
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
    if (a === `--${name}` && argv[k + 1] && !argv[k + 1]!.startsWith("--")) return argv[k + 1];
  }
  return undefined;
}
const flag = (name: string) => argv.includes(`--${name}`);
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const split = arg("split") ?? "heldout";
if (split !== "heldout" && split !== "tuning") fail(`--split is heldout or tuning, not ${split}`);
const arms = (arg("arms") ?? ARMS.join(",")).split(",") as Arm[];
for (const a of arms) if (!ARMS.includes(a)) fail(`no arm ${a}: the arms are ${ARMS.join(", ")}`);
const repeats = Number(arg("repeats") ?? 3);
const only = arg("only");

/** What each arm sends (§31): kept with the results, which a changed prompt makes stale. */
const PROMPTS: Record<Arm, string> = {
  A: `${REVIEW_V1}: the ticket, the diff and the criterion`,
  B: `${JUDGE_V1}: text only, no media`,
  C: `${JUDGE_V1}: text, the annotated still, the judge videos as stills at ${STILLS_FPS} fps`,
  D: `${JUDGE_V1}: text, the annotated still, the judge videos`,
};

// The cases and their packs, checked against the manifest: the results name what they judged.
const cases = loadCases().filter((c) => c.split === split);
const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as {
  rows: { case: string; criterion: string; sha256: string }[];
};
const recorded = new Map(manifest.rows.map((r) => [`${r.case}/${r.criterion}`, r.sha256]));
const items: BenchItem[] = [];
const packs: Record<string, string> = {};
const problems: string[] = [];
for (const c of cases) {
  const ticket = loadTicket(c.ticket);
  const diff = readDiff(PACKS_DIR, c.id);
  for (const criterion of ticket.criteria) {
    const name = `${c.id}/${criterion.id}`;
    if (only && !name.startsWith(only)) continue;
    const pack = readPack(PACKS_DIR, c.id, criterion.id);
    const sha = pack && folderHash(packDir(PACKS_DIR, c.id, criterion.id));
    if (!pack || !diff) problems.push(`${name}: no ${pack ? "diff" : "pack"} in ${PACKS_DIR}`);
    else if (sha !== recorded.get(name)) problems.push(`${name}: not the pack manifest.json lists`);
    else {
      items.push({ case: c, criterion, ticket, pack, diff });
      packs[name] = sha;
    }
  }
}
if (problems.length > 0) {
  fail(
    [
      "The packs don't match manifest.json; copy them from the machine that recorded them, or",
      "record them with pnpm bench:record (see bench/intentbench/README.md):",
      ...problems.map((p) => `  ${p}`),
    ].join("\n"),
  );
}
if (items.length === 0) fail(`nothing to judge in the ${split} split${only ? ` for ${only}` : ""}`);

// What the run will ask: the first take of each criterion (a fail or a tie asks again, §19 e).
const judgeable = items.filter((i) => i.pack.takes).length;
const firstCalls = (judge: JudgeName) =>
  repeats *
  arms
    .filter((a) => ARM_JUDGES[a].includes(judge))
    .reduce((n, a) => n + (a === "A" ? items.length : judgeable), 0);
console.log(
  `${split}: ${items.length} criteria (${judgeable} with takes) × arms ${arms.join(", ")} × ${repeats} repeats`,
);
console.log(
  `first-take calls: Spark 1.3 ${firstCalls("Spark 1.3")}, Spark Open ${firstCalls("Spark Open")}; a fail or a tie adds one more (§19 e)`,
);
if (flag("dry-run")) process.exit(0);

// The judges: both for arm D, else Spark 1.3 alone, as judgesFromEnv() makes them.
const needOpen = arms.some((a) => ARM_JUDGES[a].includes("Spark Open"));
const pair = judgesFromEnv(process.env);
const metaKey = process.env.META_API_KEY ?? process.env.MODEL_API_KEY;
let judges: Partial<Record<JudgeName, Judge>>;
if (pair) judges = { "Spark Open": pair[0], "Spark 1.3": pair[1] };
else if (needOpen) judges = fail("arm D needs META_API_KEY and BASETEN_API_KEY in .env");
else if (!metaKey) judges = fail("bench:judge needs META_API_KEY in .env");
else {
  const port = metaModelPort({ apiKey: metaKey });
  judges = { "Spark 1.3": { name: "Spark 1.3", model: SPARK_13_MODEL, port, effort: "low" } };
}
const secrets = [
  metaKey,
  process.env.BASETEN_API_KEY,
  process.env.SPARK_OPEN_API_KEY,
  process.env.DEMO_SHOP_HOOK_SECRET,
  process.env.DEMO_SHOP_BYPASS_SECRET,
].filter((s): s is string => !!s);
const redact = (text: string) => secrets.reduce((out, s) => out.replaceAll(s, "[redacted]"), text);

// Earlier results for the same split go on, unless a prompt changed or --fresh says otherwise.
const out =
  arg("out") ??
  (only
    ? join(RESULTS_DIR, "raw", `judge-${split}-${only.replaceAll("/", "_")}.json`)
    : join(RESULTS_DIR, `judge-${split}.json`));
const now = () => new Date().toISOString();
const before = flag("fresh") ? null : readResults(out);
for (const a of arms) {
  const was = before?.prompts[a];
  if (was && was !== PROMPTS[a]) fail(`arm ${a} sent "${was}" in ${out}; run with --fresh`);
}
const kept = before ? stillCurrent(before, packs) : null;
const results: BenchResults = {
  version: 1,
  split,
  prompts: { ...kept?.prompts, ...Object.fromEntries(arms.map((a) => [a, PROMPTS[a]])) },
  models: {
    ...kept?.models,
    ...("Spark 1.3" in judges && { "Spark 1.3": judges["Spark 1.3"]!.model }),
    ...(needOpen && { "Spark Open": judges["Spark Open"]?.model ?? SPARK_OPEN_MODEL }),
  },
  startedAt: kept?.startedAt ?? now(),
  updatedAt: now(),
  packs: { ...kept?.packs, ...packs },
  verdicts: kept?.verdicts ?? [],
  calls: kept?.calls ?? [],
};
mkdirSync(dirname(out), { recursive: true });
const save = () => {
  results.updatedAt = now();
  writeFileSync(out, formatResults(BenchResults.parse(results)));
};

const started = Date.now();
const summary = await judgeAll(items, {
  dir: PACKS_DIR,
  stillsDir: join(RESULTS_DIR, "raw", "stills"),
  judges,
  arms,
  repeats,
  done: new Set(results.verdicts.map(itemKey)),
  log: (line) => console.log(line),
  redact,
  concurrency: Number(arg("concurrency") ?? 4),
  maxUsd: Number(arg("max-usd") ?? 6),
  maxOpenUsd: Number(arg("max-open-usd") ?? 0.6),
  onJudged: (judging) => {
    results.verdicts.push(...judging.verdicts);
    results.calls.push(...judging.calls);
    save();
  },
});
save();

const minutes = ((Date.now() - started) / 60_000).toFixed(1);
console.log(
  `\njudged ${summary.judged}, crashed ${summary.crashed.length}, not started ${summary.left} in ${minutes} min; spent $${summary.usd.toFixed(4)} (Spark Open $${summary.openUsd.toFixed(4)})`,
);
if (summary.stopped) console.log(`stopped: ${summary.stopped}`);
for (const key of summary.crashed) console.log(`  not judged: ${key} (run again to retry)`);
const failed = results.calls.filter((c) => !c.ok).length;
if (failed > 0) console.log(`${failed} calls had no answer: their verdicts say infra_error`);
console.log(`\n${out}: every repeat so far`);
console.log("arm view        n  right wrong incon  caught   $");
for (const t of tally(results.verdicts)) {
  console.log(
    `${t.arm}   ${t.view.padEnd(10)} ${String(t.n).padStart(3)} ${String(t.right).padStart(6)} ${String(t.wrong).padStart(5)} ${String(t.inconclusive).padStart(5)}  ${`${t.caught}/${t.fails}`.padStart(6)}  ${t.usd.toFixed(3)}`,
  );
}
process.exitCode = summary.crashed.length > 0 || summary.stopped ? 1 : 0;
