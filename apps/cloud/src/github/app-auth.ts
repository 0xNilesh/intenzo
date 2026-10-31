// Acting as the App (§12): a JWT signed with the App's private key mints installation tokens, and
// every API call uses one. docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/
// generating-a-json-web-token-jwt-for-a-github-app and …/authenticating-as-a-github-app-installation
import { createSign } from "node:crypto";

import { z } from "zod";

import { errorText, GITHUB_API, GITHUB_HEADERS, GitHubError } from "./api.ts";

/**
 * An RS256 JWT issued by the App. As GitHub's docs advise, iat is 60 s in the past to allow for
 * clock drift and exp at most 10 minutes ahead (here 9).
 */
export function appJwt(appId: number, privateKeyPem: string, nowS: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: nowS - 60, exp: nowS + 540, iss: String(appId) })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKeyPem, "base64url");
  return `${unsigned}.${signature}`;
}

const Minted = z.object({ token: z.string().min(1), expires_at: z.iso.datetime() });

/** A token is minted again when it has less than this left. They last an hour. */
const RENEW_BEFORE_MS = 5 * 60_000;

export interface AppCredentials {
  appId: number;
  privateKey: string;
}

/** Installation tokens for one App: each minted once and reused until shortly before it expires. */
export function installationTokens(
  app: AppCredentials,
  now: () => Date = () => new Date(),
): (installationId: number) => Promise<string> {
  const cache = new Map<number, { token: string; expiresAt: number }>();
  return async (installationId) => {
    const cached = cache.get(installationId);
    if (cached && cached.expiresAt - now().getTime() > RENEW_BEFORE_MS) return cached.token;

    const jwt = appJwt(app.appId, app.privateKey, Math.floor(now().getTime() / 1000));
    const response = await fetch(
      `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${jwt}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      const why = await errorText(response);
      throw new GitHubError(
        response.status,
        `minting a token for installation ${installationId}: ${why}`,
      );
    }
    const minted = Minted.parse(await response.json());
    cache.set(installationId, { token: minted.token, expiresAt: Date.parse(minted.expires_at) });
    return minted.token;
  };
}
