// The Phase 4 gate (ROADMAP P4, #39): criteria read from the PM's recording and verdicts from two
// Meta judges, streamed into the PR comment, on hosted runs.
//   pnpm gate:p4 --almost-right=<pr> --correct=<pr> [--runs=3]
// Like every gate it runs `pnpm check:all` first, which holds every P4 test. gate:p3's live part
// records on demo-shop served locally and passed on 2026-10-31 (DECISIONS · P3 gate); it isn't run
// again here. Then, for the last --runs finished runs of two demo-shop PRs that close #5:
//   - almost-right: each run's report matches demo/expected-comment.md by what each criterion is
//     about (the total ❌, the line, the expired code and the chart ✅, "3/4 passed"), with the
//     total's readings "+0 s $50.00 · +1 s $50.00 · +3 s $50.00"
//   - correct: each run "4/4 passed": no false fail
//   - every run's criteria were read from the ticket's recording
// It reports the inconclusive rate, the time to verdict and each run's cost (they feed §27).
// Needs gh (signed in) and apps/cloud/.env.local. No model calls; nothing is created.
import { spawnSync } from "node:child_process";

import pg from "pg";

import { REPO_ROOT } from "../probe/lib/env.ts";
import type { GOLDEN } from "./lib/p4.ts";
import { goldenProblems, readRows } from "./lib/p4.ts";

const REPO = "sumithprabhu/demo-shop";
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const runsPerPr = Number(arg("runs") ?? 3);
const prs = { "almost-right": Number(arg("almost-right")), correct: Number(arg("correct")) };
if (!prs["almost-right"] || !prs.correct) {
  console.error("Usage: pnpm gate:p4 --almost-right=<pr> --correct=<pr> [--runs=3]");
  process.exit(2);
}

let failed = false;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failed = true;
  console.log(`${ok ? "✓" : "✗"} ${name}: ${detail}`);
};
const run = (command: string, args: string[]) => {
  const r = spawnSync(command, args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
};

console.log("Phase 4 gate\n");
const all = run("pnpm", ["check:all"]);
const testRuns = all.out.match(/Tests +\d+ passed/g) ?? [];
check("pnpm check:all", all.ok, all.ok ? `${testRuns.length} test runs passed` : "failed");

process.loadEnvFile(`${REPO_ROOT}apps/cloud/.env.local`);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
});
const verdictSeconds: number[] = [];
const pushSeconds: number[] = [];
const costs: number[] = [];
let criteria = 0;
let inconclusive = 0;
try {
  for (const [code, pr] of Object.entries(prs) as [keyof typeof GOLDEN, number][]) {
    const { rows } = await pool.query<{
      id: string;
      head_sha: string;
      created_at: Date;
      started_at: Date | null;
      finished_at: Date;
      cost_usd: string | null;
      source: string | null;
      inconclusive: string;
    }>(
      `select r.id, r.head_sha, r.created_at, r.started_at, r.finished_at, r.cost_usd,
              v.intent_json->>'intentSource' as source,
              (select count(*) from criteria_results c where c.run_id = r.id and c.verdict = 'inconclusive') as inconclusive
         from runs r
         join run_groups g on g.id = r.run_group_id
         join repos p on p.id = g.repo_id
         left join intent_versions v on v.id = r.intent_version_id
        where p.full_name = $1 and g.pr_number = $2 and r.state = 'done' and r.outcome <> 'superseded'
        order by r.finished_at desc limit $3`,
      [REPO, pr, runsPerPr],
    );
    console.log(`\n${code}: ${REPO}#${pr}, its last ${rows.length} finished runs`);
    if (rows.length < runsPerPr) check(`${code} runs`, false, `${rows.length} of ${runsPerPr}`);
    for (const row of rows.reverse()) {
      const checkRun = run("gh", [
        "api",
        `repos/${REPO}/commits/${row.head_sha}/check-runs?check_name=Intenzo&filter=all`,
        "--jq",
        `.check_runs[] | select(.external_id == "${row.id}") | {title: .output.title, summary: .output.summary}`,
      ]);
      const report =
        checkRun.ok && checkRun.out.trim()
          ? (JSON.parse(checkRun.out) as { title: string; summary: string })
          : null;
      const reportRows = report ? readRows(report.summary) : [];
      const problems = report ? goldenProblems(code, report.title, reportRows) : ["no check run"];
      if (row.source !== "linked_issue_video")
        problems.push(`criteria from ${row.source ?? "nowhere"}, not the recording`);
      const seconds = row.started_at
        ? Math.round((row.finished_at.getTime() - row.started_at.getTime()) / 1000)
        : NaN;
      const sincePush = Math.round((row.finished_at.getTime() - row.created_at.getTime()) / 1000);
      verdictSeconds.push(seconds);
      pushSeconds.push(sincePush);
      costs.push(Number(row.cost_usd ?? 0));
      criteria += reportRows.length;
      inconclusive += Number(row.inconclusive);
      check(
        `${code} ${row.head_sha.slice(0, 7)}`,
        problems.length === 0,
        problems[0] ??
          `${report!.title} · ${reportRows.map((r) => `${r.id} ${r.verdict}`).join(" ")} · ${seconds} s verifying, ${sincePush} s from the push · $${Number(row.cost_usd ?? 0).toFixed(3)}`,
      );
    }
  }
} finally {
  await pool.end();
}

console.log(
  `\nInconclusive: ${inconclusive} of ${criteria} criteria · time to verdict: median ${median(verdictSeconds)} s, at most ${Math.max(...verdictSeconds)} s verifying (median ${median(pushSeconds)} s from the push) · cost per run: median $${median(costs).toFixed(3)}`,
);
console.log(failed ? "\nPHASE 4 GATE: FAIL" : "\nPHASE 4 GATE: PASS");
process.exitCode = failed ? 1 : 0;
