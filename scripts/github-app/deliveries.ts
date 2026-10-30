// Saves the App's recent webhook deliveries as payload fixtures (ROADMAP T0.4):
//   pnpm github-app:fixtures --list          what GitHub delivered, nothing written
//   pnpm github-app:fixtures [--all]         write the first delivery of each kind (or every one)
// GitHub keeps an App's deliveries, payload included, whether or not the webhook URL answered, so
// no server is needed (it keeps them for a few days). Fixtures go to packages/core/fixtures/github/
// as { event, action, deliveryId, payload }, with emails and token-shaped strings redacted.
import { mkdirSync, writeFileSync } from "node:fs";

import { REPO_ROOT } from "../probe/lib/env.ts";
import { asArray, asString, dig } from "../probe/lib/json.ts";
import { appJwt, ensureOk, github, loadApp } from "./lib/app.ts";
import { fixtureName, redact } from "./lib/fixtures.ts";

const OUT = `${REPO_ROOT}packages/core/fixtures/github/`;
const list = process.argv.includes("--list");
const all = process.argv.includes("--all");

const app = loadApp();
const jwt = appJwt(app.id, app.privateKey);
const deliveries = asArray(
  ensureOk(await github(jwt, "/app/hook/deliveries?per_page=100"), "listing deliveries").body,
).sort((a, b) => asString(dig(a, "delivered_at")).localeCompare(asString(dig(b, "delivered_at"))));

const written = new Map<string, number>();
mkdirSync(OUT, { recursive: true });
for (const summary of deliveries) {
  const id = dig(summary, "id");
  const detail = ensureOk(await github(jwt, `/app/hook/deliveries/${id}`), `delivery ${id}`).body;
  const event = asString(dig(detail, "event"));
  const action = asString(dig(detail, "action")) || null;
  const payload = dig(detail, "request", "payload");
  const name = fixtureName(event, action, payload);
  const seen = written.get(name) ?? 0;
  const file = seen === 0 ? `${name}.json` : `${name}.${seen + 1}.json`;
  const at = asString(dig(detail, "delivered_at"));
  const status = String(dig(detail, "status_code") ?? "");
  const skip = list || (seen > 0 && !all);
  console.log(
    `${at}  ${event.padEnd(18)} ${String(action ?? "").padEnd(18)} HTTP ${status.padEnd(4)} ${skip ? "" : `→ ${file}`}`,
  );
  written.set(name, seen + 1);
  if (skip) continue;
  const fixture = { event, action, deliveryId: dig(detail, "guid"), payload: redact(payload) };
  writeFileSync(`${OUT}${file}`, `${JSON.stringify(fixture, null, 2)}\n`);
}
console.log(
  `\n${deliveries.length} deliveries${list ? "" : `; fixtures in ${OUT.slice(REPO_ROOT.length)}`}`,
);
