// pnpm bench:validate [--only=<case id prefix>]: proves IntentBench's labels (T6.1). Every case file is
// checked against the schema, the split is §31's, and on each case's Vercel preview every
// criterion's ground-truth check must agree with its label, and a side-effect case's unrequested
// change must be there. Needs gh (signed in) and the demo-shop secrets in .env. No model calls.
import { chromium } from "playwright";

import { type BenchCase, loadCases, loadTicket, splitCounts } from "./case.ts";
import { previewOf } from "./github.ts";
import { CHECKS, type Shop, SIDE_EFFECTS } from "./ground-truth.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
process.loadEnvFile(`${ROOT}.env`);
/** Cases whose id starts with this: --only=limit checks the three limit cases. */
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);

let failed = false;
const report = (ok: boolean, line: string) => {
  if (!ok) failed = true;
  console.log(`${ok ? "✓" : "✗"} ${line}`);
};

// §31's stratified split.
const cases = loadCases();
const counts = splitCounts(cases);
const want = {
  tuning: { correct: 1, almost_right: 2, side_effect: 1 },
  heldout: { correct: 3, almost_right: 3, side_effect: 1, broken: 1 },
};
const same = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys({ ...a, ...b }).every((k) => a[k] === b[k]);
report(
  same(counts.tuning, want.tuning) && same(counts.heldout, want.heldout),
  `${cases.length} cases; tuning ${JSON.stringify(counts.tuning)}, held out ${JSON.stringify(counts.heldout)}`,
);

const hook = {
  hookPath: "/api/test/session",
  secret: process.env.DEMO_SHOP_HOOK_SECRET ?? "",
};
const bypass = process.env.DEMO_SHOP_BYPASS_SECRET;
const browser = await chromium.launch();
try {
  const selected = cases.filter((c) => !only || c.id.startsWith(only));
  // Three cases at a time: each check is its own shopper, so they can't disturb each other.
  for (let i = 0; i < selected.length; i += 3) {
    const lines = await Promise.all(selected.slice(i, i + 3).map((c) => validate(c)));
    for (const caseLines of lines) for (const [ok, line] of caseLines) report(ok, line);
  }
} finally {
  await browser.close();
}
console.log(failed ? "\nbench:validate: FAIL" : "\nbench:validate: every label proven");
process.exitCode = failed ? 1 : 0;

async function validate(c: BenchCase): Promise<[boolean, string][]> {
  const origin = previewOf(c.branch);
  if (!origin) return [[false, `${c.id}: no preview for ${c.branch}`]];
  const shop: Shop = { browser, origin, hook, ...(bypass && { bypass }) };
  const out: [boolean, string][] = [];
  const checks = CHECKS[c.ticket];
  for (const criterion of loadTicket(c.ticket).criteria) {
    const holds = await checks[criterion.id]!(shop);
    const observed = holds ? "pass" : "fail";
    const label = c.labels[criterion.id];
    out.push([
      observed === label,
      `${c.id} ${criterion.id} ${label}${observed === label ? "" : ` (the page says ${observed})`}: ${criterion.text}`,
    ]);
  }
  const side = SIDE_EFFECTS[c.id];
  if (c.sideEffect) {
    const there = side ? await side(shop) : false;
    out.push([there, `${c.id} side effect on ${c.sideEffect.route}: ${c.sideEffect.description}`]);
  }
  return out;
}
