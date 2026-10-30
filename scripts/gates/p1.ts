// The Phase 1 gate (ROADMAP P1, #17): the evidence engine, end to end, on the local branches.
//   pnpm gate:p1 [--runs=3] [--out=<dir>]
// Like every gate it runs `pnpm check:all` first (unit + contract + browser tests). Then it
// records each hand-written path (fixtures/paths, C1–C4) on the PR branch and on the base branch,
// --runs times in a row, and every lane must:
//   - read exactly what fixtures/ground-truth.json says (status, and every reading by label,
//     phase and POST offset; scripts/gates/lib/p1.ts)
//   - align its video (no infra_error) and produce human.mp4 and judge.mp4
//   - produce the annotated Tt+1 s still, when the trigger ran (a trigger_absent lane has no Tt)
// Prints a table and exits 1 on any miss.
// Needs both demo-shop branches served locally (the URLs in fixtures/ground-truth.json:
// pr/discount-almost-right on :3001, main on :3000, e.g. `pnpm build && pnpm start -p 3001`),
// with INTENZO_HOOK_SECRET in their .env.local equal to DEMO_SHOP_HOOK_SECRET in this repo's
// .env. Needs Chromium and ffmpeg. No model calls.
// Typechecked by gates/tsconfig.json, which adds the DOM types core/browser needs.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Criterion, LaneResult, SavedPath } from "@intenzo/core";
import { nextTakeDir, postOffsets, recordCriterion, renderVideos } from "@intenzo/core/browser";
import { chromium } from "playwright";

import { loadDotEnv, REPO_ROOT } from "../probe/lib/env.ts";
import { compareLane, GroundTruth, SIDES, type Side } from "./lib/p1.ts";

const HOOK_PATH = "/api/test/session";
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const runs = Number(arg("runs") ?? 3);
const root = arg("out") ?? mkdtempSync(join(tmpdir(), "intenzo-gate-p1-"));

loadDotEnv();
const secret = process.env.DEMO_SHOP_HOOK_SECRET;
if (!secret) {
  console.error("DEMO_SHOP_HOOK_SECRET is not set (see .env.example)");
  process.exit(2);
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const truth = GroundTruth.parse(readJson(`${REPO_ROOT}fixtures/ground-truth.json`));
const ids = Object.keys(truth.criteria).sort();

console.log("Phase 1 gate\n");

const all = spawnSync("pnpm", ["check:all"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
  maxBuffer: 64 << 20,
});
const testRuns = `${all.stdout}${all.stderr}`.match(/Tests +\d+ passed/g) ?? [];
console.log(
  `${all.status === 0 ? "✓" : "✗"} pnpm check:all: ${
    all.status === 0 ? `${testRuns.length} test runs passed` : "failed (run it for details)"
  }`,
);
if (all.status !== 0) {
  console.log("\nPHASE 1 GATE: FAIL (pnpm check:all)");
  process.exit(1);
}

for (const side of SIDES) {
  const url = truth.sides[side].url;
  const up = await fetch(new URL("/cart", url)).then(
    (r) => r.ok,
    () => false,
  );
  console.log(`${up ? "✓" : "✗"} ${side} is up: ${truth.sides[side].branch} at ${url}`);
  if (!up) {
    console.log(`\nPHASE 1 GATE: FAIL (nothing answers at ${url}/cart; see the header comment)`);
    process.exit(1);
  }
}
console.log(`\nRecording ${ids.join(", ")} × pr, base × ${runs} runs into ${root}\n`);

/** Problems per "C2 pr", one list per run; an empty list is a passing lane. */
const results = new Map<string, string[][]>();

const browser = await chromium.launch();
try {
  for (let run = 0; run < runs; run++) {
    for (const id of ids) {
      const criterion = Criterion.parse(readJson(`${REPO_ROOT}fixtures/criteria/${id}.json`));
      const path = SavedPath.parse(readJson(`${REPO_ROOT}fixtures/paths/${id}.json`));
      for (const side of SIDES) {
        const problems = await recordLane(id, side, criterion, path);
        const key = `${id} ${side}`;
        results.set(key, [...(results.get(key) ?? []), problems]);
        const mark = problems.length === 0 ? "✓" : "✗";
        console.log(`  run ${run + 1} ${key.padEnd(8)} ${mark} ${problems[0] ?? ""}`);
      }
    }
  }
} finally {
  await browser.close();
}

async function recordLane(
  id: string,
  side: Side,
  criterion: Criterion,
  path: SavedPath,
): Promise<string[]> {
  const outDir = nextTakeDir(root, id, side);
  try {
    const rec = await recordCriterion(browser, {
      origin: truth.sides[side].url,
      side,
      criterion,
      path,
      outDir,
      identity: { hookPath: HOOK_PATH, secret: secret! },
    });
    const problems: string[] = [];
    // A trigger_absent base lane reports why in `error`; that's expected, anything else isn't.
    if (rec.error && rec.lane.status !== "trigger_absent") problems.push(`error: ${rec.error}`);
    const lane = LaneResult.safeParse(rec.lane);
    if (!lane.success) problems.push(`LaneResult invalid: ${lane.error.issues[0]?.message}`);
    problems.push(...compareLane(truth.criteria[id]![side], rec.lane, postOffsets(criterion)));

    if (rec.alignment.status !== "ok") {
      problems.push(`infra_error: ${rec.alignment.reason}`);
    } else if (!rec.rawVideo) {
      problems.push("no raw video");
    } else if (!Number.isFinite(rec.alignment.offsetMs)) {
      problems.push(`video offset is ${rec.alignment.offsetMs}`);
    } else {
      const videos = await renderVideos(
        {
          rawVideo: rec.rawVideo,
          rawOffsetMs: rec.alignment.offsetMs,
          markerShownAt: rec.markerShownAt,
          stepLog: rec.lane.stepLog,
          laneStartMs: rec.lane.laneStartMs,
          outDir,
        },
        { browser },
      );
      for (const [name, video] of Object.entries(videos)) {
        if (!existsSync(video.path)) problems.push(`no ${name} video at ${video.path}`);
        if (!Number.isFinite(video.offsetMs)) problems.push(`${name} offset is ${video.offsetMs}`);
      }
    }
    if (rec.lane.tTriggerMs !== null) {
      if (!rec.annotatedShotPath || !existsSync(rec.annotatedShotPath)) {
        problems.push("no annotated still");
      }
    }
    return problems;
  } catch (err) {
    return [`recording threw: ${err instanceof Error ? err.message : String(err)}`];
  }
}

console.log(
  `\n${"lane".padEnd(9)}${Array.from({ length: runs }, (_, n) => `run ${n + 1}`).join("  ")}`,
);
for (const [key, perRun] of results) {
  console.log(`${key.padEnd(9)}${perRun.map((p) => (p.length ? "  ✗  " : "  ✓  ")).join("  ")}`);
}

const failed = [...results].filter(([, perRun]) => perRun.some((p) => p.length > 0));
for (const [key, perRun] of failed) {
  perRun.forEach((problems, n) => {
    if (problems.length === 0) return;
    console.log(`\n✗ ${key}, run ${n + 1}:`);
    for (const p of problems) console.log(`    ${p}`);
  });
}
console.log(`\nTakes: ${root}`);
console.log(
  failed.length === 0
    ? `\nPHASE 1 GATE: PASS (${results.size} lanes × ${runs} runs match the ground truth)`
    : `\nPHASE 1 GATE: FAIL (${failed.map(([key]) => key).join(", ")})`,
);
process.exit(failed.length === 0 ? 0 : 1);
