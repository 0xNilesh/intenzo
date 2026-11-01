// pnpm bench:record [--only=<case id prefix>] [--concurrency=<n>]: records IntentBench's evidence
// packs (§31, T6.2) into bench/intentbench/packs/ (gitignored), then rewrites manifest.json, which
// is committed. Packs that exist are kept: a rerun records only what's missing. Exploring costs
// Meta credit, about $0.014 a criterion (P3 gate); recording is free. Needs gh (signed in) and
// META_API_KEY, DEMO_SHOP_HOOK_SECRET and DEMO_SHOP_BYPASS_SECRET in .env.
import { readFileSync, writeFileSync } from "node:fs";

import { parseConfig } from "@intenzo/core";

import { loadCases } from "./case.ts";
import { BASE_SHA, previewOf } from "./github.ts";
import { liveLab } from "./lab.ts";
import { formatManifest, MANIFEST_FILE, manifestOf, PACKS_DIR } from "./pack.ts";
import { recordAll } from "./recorder.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
process.loadEnvFile(`${ROOT}.env`);
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = arg("only");

const apiKey = process.env.META_API_KEY ?? process.env.MODEL_API_KEY;
const hookSecret = process.env.DEMO_SHOP_HOOK_SECRET;
const bypass = process.env.DEMO_SHOP_BYPASS_SECRET;
if (!apiKey || !hookSecret) {
  console.error("bench:record needs META_API_KEY and DEMO_SHOP_HOOK_SECRET in .env");
  process.exit(1);
}
const secrets = [apiKey, hookSecret, bypass].filter((s): s is string => !!s);
const redact = (text: string) => secrets.reduce((out, s) => out.replaceAll(s, "[redacted]"), text);

// demo-shop's own config, as the worker would read it.
const yml = "packages/core/fixtures/config/demo-shop.intenzo.yml";
const parsed = parseConfig(readFileSync(`${ROOT}${yml}`, "utf8"));
if (!parsed.ok) throw new Error(`${yml} doesn't parse`);
const config = parsed.config;
const hookPath = config.isolation.session_hook;
if (!hookPath) throw new Error(`${yml} has no session hook`);

const baseOrigin = previewOf(BASE_SHA);
if (!baseOrigin) throw new Error(`no preview for the base ${BASE_SHA}`);
const cases = loadCases();
const selected = cases.filter((c) => !only || c.id.startsWith(only));
const origins = new Map(selected.map((c) => [c.id, previewOf(c.branch)]));
console.log(`base ${BASE_SHA.slice(0, 7)}: ${baseOrigin}`);
for (const [id, origin] of origins) console.log(`${id}: ${origin ?? "no preview"}`);

const lab = liveLab({
  modelApiKey: apiKey,
  config,
  identity: { hookPath, secret: hookSecret },
  ...(bypass && { bypass }),
});
const started = Date.now();
try {
  const summary = await recordAll(selected, {
    dir: PACKS_DIR,
    lab,
    originOf: (c) => origins.get(c.id) ?? null,
    baseOrigin,
    redact,
    log: (line) => console.log(line),
    concurrency: Number(arg("concurrency") ?? 2),
  });
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  console.log(
    `\nrecorded ${summary.recorded}, kept ${summary.skipped}, crashed ${summary.crashed.length} in ${minutes} min; exploring cost $${summary.costUsd.toFixed(4)}`,
  );
  for (const name of summary.crashed) console.log(`  not recorded: ${name} (run again to retry)`);
  process.exitCode = summary.crashed.length > 0 ? 1 : 0;
} finally {
  await lab.close();
  // Every case, not only the selected ones: the manifest is the whole bench.
  const manifest = manifestOf(PACKS_DIR, cases, BASE_SHA);
  writeFileSync(MANIFEST_FILE, formatManifest(manifest));
  console.log(
    `manifest: ${manifest.rows.length} packs, ${manifest.missing.length} missing, exploring $${manifest.exploreUsd}`,
  );
}
