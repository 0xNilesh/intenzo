// The Phase 0 gate (ROADMAP P0): everything Phase 0 promises, checked end to end.
//   pnpm gate:p0
// Like every gate it runs `pnpm check:all` first. Then: CI is green on main; `probe:assert` passes
// (probes/results.json from `pnpm probe:all` on this machine); demo-shop's ground truth holds on
// both demo branch previews; DECISIONS.md records the go/no-go and the P0 choices; the golden
// comment covers C1–C4 + ⚠️; the demo ticket carries its video. Exits 1 if anything fails.
// Needs gh (signed in), the .env keys the ground truth uses, and Chromium. No model calls.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { REPO_ROOT } from "../probe/lib/env.ts";
import { DEMO_TICKET, missingDecisions, missingFromGolden } from "./lib/p0.ts";

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

function run(command: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(command, args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const lastLine = (text: string, pattern: RegExp) =>
  text
    .split("\n")
    .filter((l) => pattern.test(l))
    .at(-1)
    ?.trim() ?? "";

const results: Result[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}: ${detail}`);
};

console.log("Phase 0 gate\n");

const all = run("pnpm", ["check:all"]);
const tests = all.out.match(/Tests +\d+ passed/g) ?? [];
check(
  "pnpm check:all",
  all.ok,
  all.ok ? `${tests.length} test runs passed` : lastLine(all.out, /\S/),
);

const ci = run("gh", [
  "run",
  "list",
  "--branch",
  "main",
  "--workflow",
  "CI",
  "--limit",
  "1",
  "--json",
  "status,conclusion,headSha",
]);
const latest = ci.ok
  ? (JSON.parse(ci.out) as { status: string; conclusion: string; headSha: string }[])[0]
  : undefined;
check(
  "CI green on main",
  latest?.status === "completed" && latest.conclusion === "success",
  latest ? `${latest.headSha.slice(0, 7)}: ${latest.status}/${latest.conclusion}` : ci.out.trim(),
);

const probes = run("pnpm", ["probe:assert"]);
check(
  "probe:assert",
  probes.ok,
  lastLine(probes.out, /^(Done|Not done|Missing|No )/) || lastLine(probes.out, /\S/),
);

for (const branch of ["correct", "almost-right"]) {
  const truth = run("node", ["scripts/demo/ground-truth.ts", branch]);
  check(
    `ground truth: ${branch}`,
    truth.ok,
    lastLine(truth.out, /^(PROVEN|NOT PROVEN)/) || lastLine(truth.out, /\S/),
  );
}

const missing = missingDecisions(readFileSync(`${REPO_ROOT}docs/DECISIONS.md`, "utf8"));
check(
  "DECISIONS.md records the P0 choices",
  missing.length === 0,
  missing.length
    ? `missing: ${missing.join("; ")}`
    : "go/no-go, judge modes, Muse Code, Transcribe, coverage model, inconclusive rule",
);

const gaps = missingFromGolden(readFileSync(`${REPO_ROOT}demo/expected-comment.md`, "utf8"));
check(
  "golden comment covers C1–C4 + ⚠️",
  gaps.length === 0,
  gaps.length ? `missing: ${gaps.join("; ")}` : "demo/expected-comment.md",
);

const ticket = run("gh", [
  "api",
  `repos/${DEMO_TICKET.repo}/issues/${DEMO_TICKET.issue}`,
  "--jq",
  ".body",
]);
const video = /https:\/\/github\.com\/user-attachments\/assets\/[\w-]+/.exec(ticket.out)?.[0];
check(
  `demo ticket ${DEMO_TICKET.repo}#${DEMO_TICKET.issue} has its video`,
  !!video,
  video ?? "no attachment in the body",
);

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0
    ? "\nPHASE 0 GATE: PASS"
    : `\nPHASE 0 GATE: FAIL (${failed.map((r) => r.name).join(", ")})`,
);
process.exit(failed.length === 0 ? 0 : 1);
