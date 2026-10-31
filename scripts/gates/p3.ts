// The Phase 3 gate (ROADMAP P3, #31): the navigator finds every trigger by itself.
//   pnpm gate:p3 [--runs=3] [--out=<dir>]
// Like every gate it runs `pnpm check:all` first (every P3 test), then `pnpm gate:p2` when its
// database settings are here (apps/cloud/.env.local); without them that check is reported as not
// run and the gate can't pass. Then, --runs times in a row, for each of C1–C4 with no hand-written
// path:
//   - Wonder explores the PR app (pr/discount-almost-right on :3001) and must find the trigger
//   - the saved path replays with the recorder on the PR app and on the base app (main, :3000),
//     and both lanes must hold P1's facts (scripts/gates/lib/p3.ts): the discount line, the stale
//     $50.00 total until a reload, the expired-code toast, the chart; the base has no code field
//   - both videos must align (no infra_error)
// Each explore's steps, time, tokens and cost are printed (they feed §27).
// Needs both demo-shop branches served locally, as for gate:p1, META_API_KEY and
// DEMO_SHOP_HOOK_SECRET in .env, Chromium and ffmpeg. Costs about $0.012 per explore at Wonder's
// list price, so about $0.15 for 3 runs.
// Typechecked by gates/tsconfig.json, which adds the DOM types core/browser needs.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Criterion, denyText, parseConfig } from "@intenzo/core";
import { nextTakeDir, recordCriterion } from "@intenzo/core/browser";
import { metaModelPort } from "@intenzo/core/models";
import { explore } from "@intenzo/core/navigator";
import { chromium } from "playwright";

import { loadDotEnv, REPO_ROOT } from "../probe/lib/env.ts";
import { P3_CRITERIA, p3LaneProblems, wonderCostUsd } from "./lib/p3.ts";

const PR = "http://localhost:3001";
const BASE = "http://localhost:3000";
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const runs = Number(arg("runs") ?? 3);
const out = arg("out") ?? mkdtempSync(join(tmpdir(), "intenzo-gate-p3-"));

loadDotEnv();
let failed = false;
let incomplete = false;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failed = true;
  console.log(`${ok ? "✓" : "✗"} ${name}: ${detail}`);
};
const pnpm = (script: string) =>
  spawnSync("pnpm", [script], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 << 20 });

// 1. Every P3 test.
const all = pnpm("check:all");
const counts = (all.stdout.match(/Tests +\d+ passed/g) ?? []).map((m) => m.replace(/\s+/g, " "));
check(
  "pnpm check:all",
  all.status === 0,
  all.status === 0 ? `${counts.length} test runs passed` : "failed",
);
if (all.status !== 0) {
  console.log(all.stdout.slice(-3000));
  console.log("\nPHASE 3 GATE: FAIL (pnpm check:all)");
  process.exit(1);
}

// 2. The Phase 2 gate, which needs the Cloud's database.
if (existsSync(join(REPO_ROOT, "apps/cloud/.env.local"))) {
  const p2 = pnpm("gate:p2");
  check(
    "pnpm gate:p2",
    p2.status === 0,
    p2.status === 0 ? "passed" : `failed:\n${p2.stdout.slice(-2000)}`,
  );
} else {
  incomplete = true;
  console.log("… pnpm gate:p2: not run (it needs apps/cloud/.env.local, the Cloud's database)");
}

// 3. Live: explore, then replay on both sides.
const apiKey = process.env.META_API_KEY;
const hookSecret = process.env.DEMO_SHOP_HOOK_SECRET;
if (!apiKey || !hookSecret) {
  check("keys", false, "META_API_KEY and DEMO_SHOP_HOOK_SECRET must be in .env");
  process.exit(1);
}
for (const [name, origin] of [
  ["pr", PR],
  ["base", BASE],
] as const) {
  const res = await fetch(`${origin}/cart`).catch(() => null);
  check(
    `${name} is up`,
    res?.ok === true,
    `${origin}/cart answered ${res ? res.status : "nothing"}`,
  );
}
if (failed) process.exit(1);

const parsed = parseConfig(
  readFileSync(join(REPO_ROOT, "packages/core/fixtures/config/demo-shop.intenzo.yml"), "utf8"),
);
if (!parsed.ok) throw new Error("the demo-shop config fixture doesn't parse");
const config = parsed.config;
const identity = { hookPath: config.isolation.session_hook!, secret: hookSecret };
const model = metaModelPort({ apiKey });
const criteria = Object.fromEntries(
  P3_CRITERIA.map((id) => [
    id,
    Criterion.parse(
      JSON.parse(readFileSync(join(REPO_ROOT, `fixtures/criteria/${id}.json`), "utf8")),
    ),
  ]),
);

interface Row {
  run: number;
  id: string;
  steps: number;
  seconds: number;
  usd: number;
  problems: string[];
}
const rows: Row[] = [];
const browser = await chromium.launch();
try {
  for (let run = 1; run <= runs; run++) {
    for (const id of P3_CRITERIA) {
      const criterion = criteria[id]!;
      const explored = await explore(browser, {
        origin: PR,
        criterion,
        model,
        denyText: denyText(config),
        startPath: config.start.default,
        data: config.data,
        identity,
      });
      const row: Row = {
        run,
        id,
        steps: explored.steps.length,
        seconds: explored.ms / 1000,
        usd: wonderCostUsd(explored.usage),
        problems: [],
      };
      rows.push(row);
      if (explored.status !== "found") {
        row.problems.push(`explore ${explored.status}: ${explored.reason}`);
        continue;
      }
      for (const [side, origin] of [
        ["pr", PR],
        ["base", BASE],
      ] as const) {
        const recording = await recordCriterion(browser, {
          origin,
          side,
          criterion,
          path: explored.path,
          outDir: nextTakeDir(join(out, `run-${run}`), id, side),
          identity,
        });
        if (recording.alignment.status !== "ok")
          row.problems.push(`${side}: ${recording.alignment.reason}`);
        row.problems.push(...p3LaneProblems(id, recording.lane));
      }
    }
  }
} finally {
  await browser.close();
}

console.log("\nrun  criterion  explore            replay (pr + base)");
for (const r of rows) {
  const explore = `${r.steps} steps ${r.seconds.toFixed(1).padStart(5)} s $${r.usd.toFixed(4)}`;
  console.log(
    ` ${r.run}   ${r.id}         ${explore}  ${r.problems.length ? `✗ ${r.problems.join("; ")}` : "✓"}`,
  );
}
for (const id of P3_CRITERIA) {
  const mine = rows.filter((r) => r.id === id);
  const mean = (f: (r: Row) => number) => mine.reduce((n, r) => n + f(r), 0) / mine.length;
  console.log(
    `${id}: explore ${mean((r) => r.seconds).toFixed(1)} s and ${mean((r) => r.steps).toFixed(1)} steps on average`,
  );
}
const total = rows.reduce((n, r) => n + r.usd, 0);
const bad = rows.filter((r) => r.problems.length > 0);
check(
  `live (${runs} runs × C1–C4)`,
  bad.length === 0,
  `${rows.length - bad.length}/${rows.length} explored and replayed; $${total.toFixed(3)} of Wonder calls; takes in ${out}`,
);

if (failed) {
  console.log("\nPHASE 3 GATE: FAIL");
  process.exit(1);
}
if (incomplete) {
  console.log(
    "\nPHASE 3 GATE: everything here passed, but gate:p2 wasn't run (needs apps/cloud/.env.local)",
  );
  process.exit(2);
}
console.log("\nPHASE 3 GATE: PASS");
