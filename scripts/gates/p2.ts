// The Phase 2 gate (ROADMAP P2, #25): the hosted walking skeleton, checked end to end.
//   pnpm gate:p2 [--run=<runId>]
// Like every gate it runs `pnpm check:all` first, which holds every P2 unit test. Then:
//   - CI is green on main: it also runs the Postgres tests, which need a server
//   - the Cloud refuses an unsigned webhook and a sweep without its secret (401)
//   - P1's ground truth holds on a hosted run: each of C1–C4's PR and base lanes, recorded on
//     Modal, reads what fixtures/ground-truth.json says and cites its human video
//   - the run's report page plays them: a signed video URL answers with video/mp4
//   - the run's PR has one Intenzo comment, and each superseded run's check run is neutral
// The run is --run, else the latest finished demo-shop run with recordings. The gate's end-to-end
// check leaves one: a demo-shop PR on the almost-right branch, pushed twice (ROADMAP P2).
// gate:p1 itself records on local servers; this gate scores the hosted recordings against the
// same ground truth instead (DECISIONS 2026-10-31 · P2 gate).
// Needs gh (signed in) and apps/cloud/.env.local (the database). No model calls; nothing is
// created or changed.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { Criterion, LaneResult } from "@intenzo/core";
import { postOffsets } from "@intenzo/core/browser";
import pg from "pg";

import { REPO_ROOT } from "../probe/lib/env.ts";
import { GroundTruth, SIDES } from "./lib/p1.ts";
import { hostedLaneProblems, videoSources } from "./lib/p2.ts";

const CLOUD = (process.env.INTENZO_CLOUD_URL ?? "https://intenzo-cloud.vercel.app").replace(
  /\/$/,
  "",
);
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

let failed = false;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failed = true;
  console.log(`${ok ? "✓" : "✗"} ${name}: ${detail}`);
};
const run = (command: string, args: string[]) => {
  const r = spawnSync(command, args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

console.log("Phase 2 gate\n");

const all = run("pnpm", ["check:all"]);
const testRuns = all.out.match(/Tests +\d+ passed/g) ?? [];
check("pnpm check:all", all.ok, all.ok ? `${testRuns.length} test runs passed` : "failed");

const ci = run("gh", [
  "run",
  "list",
  "--branch",
  "main",
  "--limit",
  "1",
  "--json",
  "conclusion,headSha",
]);
const [latest] = ci.ok ? (JSON.parse(ci.out) as { conclusion: string; headSha: string }[]) : [];
check(
  "CI on main",
  latest?.conclusion === "success",
  latest ? `${latest.conclusion || "running"} at ${latest.headSha.slice(0, 7)}` : "unknown",
);

const webhook = await fetch(`${CLOUD}/api/github/webhook`, {
  method: "POST",
  headers: { "x-github-event": "ping", "x-github-delivery": "gate-p2", "content-type": "json" },
  body: "{}",
});
check("unsigned webhook refused", webhook.status === 401, `HTTP ${webhook.status}`);
const sweep = await fetch(`${CLOUD}/api/internal/sweep`, { method: "POST" });
check("sweep without its secret refused", sweep.status === 401, `HTTP ${sweep.status}`);

process.loadEnvFile(`${REPO_ROOT}apps/cloud/.env.local`);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
});
try {
  const runId =
    arg("run") ??
    (
      await pool.query<{ id: string }>(
        `select r.id from runs r
           join run_groups g on g.id = r.run_group_id
           join repos p on p.id = g.repo_id
          where p.full_name = 'sumithprabhu/demo-shop' and r.state = 'done'
            and exists (select 1 from criteria_results c
                         where c.run_id = r.id and jsonb_array_length(c.lanes_json) > 0)
          order by r.finished_at desc limit 1`,
      )
    ).rows[0]?.id;
  if (!runId)
    throw new Error("no finished demo-shop run with recordings: run the end-to-end check");
  const { rows } = await pool.query<{ criterion_id: string; lanes_json: unknown[] }>(
    "select criterion_id, lanes_json from criteria_results where run_id = $1",
    [runId],
  );
  console.log(`\nRun ${runId} (${rows.length} criteria)`);

  const truth = GroundTruth.parse(readJson(`${REPO_ROOT}fixtures/ground-truth.json`));
  let lanesWithVideo = 0;
  for (const id of Object.keys(truth.criteria).sort()) {
    const criterion = Criterion.parse(readJson(`${REPO_ROOT}fixtures/criteria/${id}.json`));
    const lanes = (rows.find((r) => r.criterion_id === id)?.lanes_json ?? []).map((l) =>
      LaneResult.parse(l),
    );
    for (const side of SIDES) {
      const lane = lanes.find((l) => l.side === side);
      if (lane?.humanVideo) lanesWithVideo += 1;
      const problems = hostedLaneProblems(truth.criteria[id]![side], lane, postOffsets(criterion));
      check(`${id} ${side}`, problems.length === 0, problems[0] ?? `${lane!.status}, video cited`);
    }
  }

  const page = await fetch(`${CLOUD}/r/${runId}`);
  const sources = videoSources(await page.text());
  check(
    "report page",
    page.status === 200 && sources.length === lanesWithVideo,
    `HTTP ${page.status}, ${sources.length} videos for ${lanesWithVideo} recorded lanes`,
  );
  if (sources[0]) {
    const video = await fetch(sources[0].split("#")[0]!, { headers: { range: "bytes=0-15" } });
    const type = video.headers.get("content-type");
    check("a video plays", video.ok && type === "video/mp4", `HTTP ${video.status} ${type}`);
  }

  const group = await pool.query<{ pr_number: number; full_name: string }>(
    `select g.pr_number, p.full_name from runs r
       join run_groups g on g.id = r.run_group_id join repos p on p.id = g.repo_id
      where r.id = $1`,
    [runId],
  );
  const { pr_number: pr, full_name: repo } = group.rows[0]!;
  const comments = run("gh", [
    "api",
    `repos/${repo}/issues/${pr}/comments`,
    "--jq",
    '[.[] | select(.user.login == "intenzo-ai[bot]")] | length',
  ]);
  check(
    `one comment on ${repo}#${pr}`,
    comments.out.trim() === "1",
    `${comments.out.trim()} found`,
  );

  const superseded = await pool.query<{ id: string; head_sha: string }>(
    `select r.id, r.head_sha from runs r
      where r.run_group_id = (select run_group_id from runs where id = $1)
        and r.outcome = 'superseded'`,
    [runId],
  );
  for (const s of superseded.rows) {
    const conclusion = run("gh", [
      "api",
      `repos/${repo}/commits/${s.head_sha}/check-runs?check_name=Intenzo&filter=all`,
      "--jq",
      `.check_runs[] | select(.external_id == "${s.id}") | .conclusion`,
    ]).out.trim();
    check(`superseded ${s.head_sha.slice(0, 7)}`, conclusion === "neutral", conclusion || "none");
  }
  if (superseded.rows.length === 0) {
    check("a superseded run", false, "none in this run's PR: push twice in the end-to-end check");
  }
} catch (err) {
  check("hosted run", false, (err as Error).message);
} finally {
  await pool.end();
}

console.log(failed ? "\nPHASE 2 GATE: FAIL" : "\nPHASE 2 GATE: PASS");
process.exitCode = failed ? 1 : 0;
