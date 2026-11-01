// The Phase 5 gate (ROADMAP P5, #47): the whole demo loop, live, twice in a row.
//   pnpm gate:p5 --loops=<pr>,<pr> [--p4=17,18]
// First gate:p4 on the P4 gate's PRs, which runs `pnpm check:all` (every P5 test with it). Then, for
// each loop (a demo-shop PR on the almost-right code that closes #5):
//   1. its first finished run matches the golden comment: the total ❌ with its GIF, the chart ✅
//      with SAM's, and the ⚠️ line for the renamed link
//   2. one fix request, and a commit by intenzo-fixer[bot] that the repo's CI passed
//   3. the run on that commit: 4/4 passed
//   4. "Intenzo / product approval" success on it, main requiring it, and GitHub allowing the merge
// Needs gh (signed in) and apps/cloud/.env.local. No model calls; nothing is created.
import { spawnSync } from "node:child_process";

import pg from "pg";

import { REPO_ROOT } from "../probe/lib/env.ts";
import { failedRunProblems, loopProblems, passedRunProblems } from "./lib/p5.ts";

const REPO = "sumithprabhu/demo-shop";
const APPROVAL = "Intenzo / product approval";
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const loops = (arg("loops") ?? "").split(",").filter(Boolean).map(Number);
const [p4AlmostRight, p4Correct] = (arg("p4") ?? "17,18").split(",").map(Number);
if (loops.length < 2 || loops.some((n) => !n)) {
  console.error("Usage: pnpm gate:p5 --loops=<pr>,<pr> [--p4=<almost-right>,<correct>]");
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
const gh = <T>(path: string, jq?: string): T | null => {
  const r = run("gh", ["api", path, ...(jq ? ["--jq", jq] : [])]);
  if (!r.ok || !r.out.trim()) return null;
  return JSON.parse(r.out) as T;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const minutes = (from: Date, to: Date) =>
  `${((to.getTime() - from.getTime()) / 60_000).toFixed(1)} min`;

console.log("Phase 5 gate\n");
const p4 = run("pnpm", ["gate:p4", `--almost-right=${p4AlmostRight}`, `--correct=${p4Correct}`]);
check("gate:p4 (with pnpm check:all)", p4.ok, p4.out.trim().split("\n").at(-1) ?? "");

process.loadEnvFile(`${REPO_ROOT}apps/cloud/.env.local`);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
});
const required =
  gh<string[]>(`repos/${REPO}/branches/main/protection`, "[.required_status_checks.contexts[]]") ??
  [];
try {
  for (const [n, pr] of loops.entries()) {
    console.log(`\nLoop ${n + 1}: ${REPO}#${pr}`);
    const { rows: runs } = await pool.query<{
      id: string;
      head_sha: string;
      outcome: string;
      finished_at: Date;
      cost_usd: string | null;
      group_id: string;
    }>(
      `select r.id, r.head_sha, r.outcome, r.finished_at, r.cost_usd, g.id as group_id
         from runs r
         join run_groups g on g.id = r.run_group_id
         join repos p on p.id = g.repo_id
        where p.full_name = $1 and g.pr_number = $2 and r.state = 'done'
          and r.outcome not in ('superseded', 'cancelled')
        order by r.finished_at`,
      [REPO, pr],
    );
    const first = runs.find((r) => r.outcome === "fail");
    const passing = runs.filter((r) => r.outcome === "pass").at(-1);
    const report = (r: { id: string; head_sha: string }) =>
      gh<{ title: string; summary: string }>(
        `repos/${REPO}/commits/${r.head_sha}/check-runs?check_name=Intenzo&filter=all`,
        `.check_runs[] | select(.external_id == "${r.id}") | {title: .output.title, summary: .output.summary}`,
      );

    // 1. The failing run.
    const one = first && report(first);
    const oneProblems = one ? failedRunProblems(one.title, one.summary) : ["no failed run"];
    check(
      "1 the almost-right run",
      oneProblems.length === 0,
      oneProblems[0] ?? `${one!.title}, both GIFs and the ⚠️ line`,
    );

    // 2–4. The request, the fixer's commit and CI, the passing run, the approval and the merge.
    const groupId = first?.group_id ?? runs[0]?.group_id;
    const { rows: requests } = await pool.query<{ n: string }>(
      `select count(*) as n from outbox where effect = 'agent' and group_id = $1`,
      [groupId ?? -1],
    );
    const fixerSha = gh<string>(
      `repos/${REPO}/pulls/${pr}/commits`,
      `[.[] | select(.author.login == "intenzo-fixer[bot]" or .commit.author.name == "intenzo-fixer[bot]")][-1].sha`,
    );
    const ci = fixerSha
      ? gh<string>(
          `repos/${REPO}/commits/${fixerSha}/check-runs?check_name=check`,
          ".check_runs[0].conclusion",
        )
      : null;
    const three = passing && report(passing);
    const threeProblems = three
      ? passedRunProblems(three.title, three.summary)
      : ["no passing run"];
    if (passing && fixerSha && passing.head_sha !== fixerSha)
      threeProblems.push(`the passing run is on ${passing.head_sha.slice(0, 7)}, not the fix`);
    const approval = passing
      ? gh<{ state: string; description: string; created_at: string }>(
          `repos/${REPO}/commits/${passing.head_sha}/statuses`,
          `[.[] | select(.context == "${APPROVAL}")][0]`,
        )
      : null;
    // GitHub works out mergeability after a request asks; give it a moment.
    let mergeableState: string | null = null;
    for (let i = 0; i < 5 && (mergeableState === null || mergeableState === "unknown"); i++) {
      mergeableState = gh<string>(`repos/${REPO}/pulls/${pr}`, ".mergeable_state");
      if (mergeableState === "unknown") await sleep(2000);
    }
    const loopIssues = loopProblems({
      fixRequests: Number(requests[0]?.n ?? 0),
      fixer: fixerSha ? { sha: fixerSha, ci } : null,
      approval,
      mergeableState,
      required,
    });
    check(
      "2 Send to agent → muse-fixer → CI",
      loopIssues.filter((p) => /fix|CI/.test(p)).length === 0,
      loopIssues.find((p) => /fix|CI/.test(p)) ??
        `one request, fix ${fixerSha!.slice(0, 7)}, CI ${ci}`,
    );
    check("3 the run on the fix", threeProblems.length === 0, threeProblems[0] ?? three!.title);
    const rest = loopIssues.filter((p) => !/fix|CI/.test(p));
    check(
      "4 PM approval, merge allowed",
      rest.length === 0,
      rest[0] ?? `${approval!.description}; merge state ${mergeableState}`,
    );
    if (first && passing) {
      const cost = runs.reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0);
      const approved = approval ? new Date(approval.created_at) : null;
      console.log(
        `  fail → pass: ${minutes(first.finished_at, passing.finished_at)}${approved ? `, → approved ${minutes(passing.finished_at, approved)} later` : ""} · runs $${cost.toFixed(3)}`,
      );
    }
  }
} finally {
  await pool.end();
}

console.log(failed ? "\nPHASE 5 GATE: FAIL" : "\nPHASE 5 GATE: PASS");
process.exitCode = failed ? 1 : 0;
