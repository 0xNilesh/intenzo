// Registers a GitHub App from the §12 manifest through GitHub's manifest flow (ROADMAP T0.4, T2.1):
//   [GITHUB_APP_ENV=.env.intenzo-app] pnpm github-app:create [--name=intenzo-t04-xxxxxx] [--hook=https://example.com/intenzo-webhook]
// It prints a localhost link. Open it, press the button, confirm on github.com, and GitHub sends the
// browser back here with a one-hour code, which is exchanged for the App's id, private key and
// webhook secret. They go to .env.github-app and .env.github-app.pem, or the file GITHUB_APP_ENV
// names (gitignored, mode 600), and are never printed. T0.4's default webhook URL answers nothing
// useful, which is fine: GitHub keeps every delivery's payload, and deliveries.ts reads them back.
// The real App (T2.1) gets the Cloud's URL: --hook=https://<cloud>/api/github/webhook.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { request } from "../probe/lib/http.ts";
import { asString, dig } from "../probe/lib/json.ts";
import { APP_ENV_FILE, APP_ENV_NAME, APP_KEY_FILE, GITHUB_API, GITHUB_HEADERS } from "./lib/app.ts";
import { buildManifest } from "./manifest.ts";

const option = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const name = option("name") ?? `intenzo-t04-${randomBytes(3).toString("hex")}`;
const hookUrl = option("hook") ?? "https://example.com/intenzo-webhook";
if (existsSync(APP_ENV_FILE) && !process.argv.includes("--force")) {
  console.error(`${APP_ENV_NAME} already exists. Use --force to register another App over it.`);
  process.exit(2);
}
const state = randomBytes(16).toString("hex");
let origin = "";

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", origin);
  const page = (status: number, body: string) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta charset="utf-8"><body style="font:18px system-ui; margin:3em">${body}`,
    );
  };
  if (url.pathname === "/") {
    const manifest = buildManifest({
      name,
      hookUrl,
      redirectUrl: `${origin}/callback`,
      description: "Intenzo: proof that a PR does what its ticket asked, on video.",
    });
    return page(
      200,
      `<h1>Register ${escapeHtml(name)}</h1>
<p>Creates a private GitHub App with the Intenzo §12 permissions under the account you're signed in as.</p>
<form action="https://github.com/settings/apps/new?state=${state}" method="post">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button style="font-size:18px; padding:.5em 1em">Create the GitHub App on github.com</button></form>`,
    );
  }
  if (url.pathname !== "/callback") return page(404, "Not found");
  if (url.searchParams.get("state") !== state) return page(400, "State mismatch: start again.");
  void exchange(url.searchParams.get("code") ?? "").then(
    (slug) => {
      page(
        200,
        `<h1>Done: ${escapeHtml(slug)} is registered</h1>
<p><a href="https://github.com/apps/${slug}/installations/new">Install it</a> on the repositories it should verify, and only those.</p>`,
      );
      console.log(
        `\nRegistered ${slug}. Credentials are in ${APP_ENV_NAME} and ${APP_ENV_NAME}.pem.`,
      );
      console.log(
        `Next: install it on the repos it should verify, and only those: https://github.com/apps/${slug}/installations/new`,
      );
      server.close();
    },
    (err: unknown) => {
      page(502, `Couldn't finish: ${escapeHtml(err instanceof Error ? err.message : String(err))}`);
      console.error(err instanceof Error ? err.message : err);
      server.close();
      process.exitCode = 1;
    },
  );
});

server.listen(0, "127.0.0.1", () => {
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  console.log(
    `Open ${origin}/ in the browser where you're signed in to GitHub (code valid 1 hour).`,
  );
});

/** Swaps the one-hour code for the App's credentials and writes them to the gitignored files. */
async function exchange(code: string): Promise<string> {
  const res = await request(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: GITHUB_HEADERS,
  });
  if (!res.ok) throw new Error(`GitHub refused the code (HTTP ${res.status})`);
  const field = (key: string) => asString(dig(res.body, key)) || String(dig(res.body, key) ?? "");
  const slug = field("slug");
  writeFileSync(APP_KEY_FILE, field("pem"), { mode: 0o600 });
  writeFileSync(
    APP_ENV_FILE,
    [
      `GITHUB_APP_ID=${field("id")}`,
      `GITHUB_APP_SLUG=${slug}`,
      `GITHUB_APP_CLIENT_ID=${field("client_id")}`,
      `GITHUB_APP_WEBHOOK_SECRET=${field("webhook_secret")}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  chmodSync(APP_KEY_FILE, 0o600);
  chmodSync(APP_ENV_FILE, 0o600);
  return slug;
}

function escapeHtml(text: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return text.replace(/[&<>"']/g, (c) => entities[c]!);
}
