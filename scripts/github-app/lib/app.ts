import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { REPO_ROOT } from "../../probe/lib/env.ts";
import { errorText, request, type HttpResult, type RequestOptions } from "../../probe/lib/http.ts";
import { asString, dig } from "../../probe/lib/json.ts";

/** Written by create-app.ts; both match .gitignore's `.env.*`. */
export const APP_ENV_FILE = `${REPO_ROOT}.env.github-app`;
export const APP_KEY_FILE = `${REPO_ROOT}.env.github-app.pem`;

export const GITHUB_API = "https://api.github.com";
export const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "intenzo-scripts",
};

export interface AppCredentials {
  id: string;
  slug: string;
  privateKey: string;
}

export function loadApp(): AppCredentials {
  if (!existsSync(APP_ENV_FILE)) {
    throw new Error("No .env.github-app: register the App first with `pnpm github-app:create`");
  }
  process.loadEnvFile(APP_ENV_FILE);
  const { GITHUB_APP_ID: id, GITHUB_APP_SLUG: slug } = process.env;
  if (!id || !slug) throw new Error(".env.github-app needs GITHUB_APP_ID and GITHUB_APP_SLUG");
  return { id, slug, privateKey: readFileSync(APP_KEY_FILE, "utf8") };
}

/**
 * A GitHub App JWT, signed RS256 with the App's private key. Per GitHub's docs, iat is set 60 s in
 * the past to allow for clock drift and exp at most 10 minutes ahead (here 9).
 */
export function appJwt(appId: string, privateKeyPem: string, nowS = Math.floor(Date.now() / 1000)) {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: nowS - 60, exp: nowS + 540, iss: appId })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKeyPem, "base64url");
  return `${unsigned}.${signature}`;
}

export function github(
  token: string,
  path: string,
  options: RequestOptions = {},
): Promise<HttpResult> {
  return request(`${GITHUB_API}${path}`, {
    ...options,
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}`, ...options.headers },
  });
}

/** Fails with GitHub's own message, which never contains our credentials. */
export function ensureOk(result: HttpResult, what: string): HttpResult {
  if (!result.ok) throw new Error(`${what}: ${errorText(result)}`);
  return result;
}

/** An installation token for the App's installation on one repository (an hour long). */
export async function installationToken(app: AppCredentials, repo: string): Promise<string> {
  const jwt = appJwt(app.id, app.privateKey);
  const installation = ensureOk(
    await github(jwt, `/repos/${repo}/installation`),
    `App ${app.slug} isn't installed on ${repo}`,
  );
  const id = dig(installation.body, "id");
  const minted = ensureOk(
    await github(jwt, `/app/installations/${id}/access_tokens`, { method: "POST" }),
    "minting an installation token",
  );
  return asString(dig(minted.body, "token"));
}
