import { createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { GitHubError } from "./api.ts";
import { appJwt, installationTokens } from "./app-auth.ts";
import { fakeGitHub, json } from "./fake-github.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

describe("appJwt", () => {
  it("is an RS256 JWT issued by the App, backdated 60 s and valid for under 10 minutes", () => {
    const [header, payload] = appJwt(5551372, pem, 1_000_000).split(".");
    expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(payload!)).toEqual({ iat: 999_940, exp: 1_000_540, iss: "5551372" });
  });

  it("is signed with the App's private key", () => {
    const [header, payload, signature] = appJwt(5551372, pem, 1_000_000).split(".");
    const ok = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, signature!, "base64url");
    expect(ok).toBe(true);
  });
});

describe("installationTokens", () => {
  const github = fakeGitHub();
  const T0 = Date.parse("2026-10-31T09:00:00.000Z");

  it("mints a token with the App's JWT and reuses it until 5 minutes before it expires", async () => {
    let now = T0;
    let minted = 0;
    let issuer: unknown;
    github.post("/app/installations/177107116/access_tokens", (request: Request) => {
      const jwt = request.headers.get("authorization")!.replace(/^Bearer /, "");
      issuer = decode(jwt.split(".")[1]!).iss;
      minted += 1;
      return { token: `ghs_${minted}`, expires_at: new Date(now + 3_600_000).toISOString() };
    });
    const token = installationTokens({ appId: 5551372, privateKey: pem }, () => new Date(now));

    expect(await token(177107116)).toBe("ghs_1");
    now += 54 * 60_000; // 6 minutes left
    expect(await token(177107116)).toBe("ghs_1");
    now += 2 * 60_000; // 4 minutes left
    expect(await token(177107116)).toBe("ghs_2");
    expect(issuer).toBe("5551372");
    expect(github.calls).toHaveLength(2);
  });

  it("keeps one token per installation", async () => {
    github.installation(1, "ghs_one");
    github.installation(2, "ghs_two");
    const token = installationTokens({ appId: 5551372, privateKey: pem });
    expect([await token(1), await token(2), await token(1)]).toEqual([
      "ghs_one",
      "ghs_two",
      "ghs_one",
    ]);
    expect(github.calls).toHaveLength(2);
  });

  it("fails with GitHub's message and never shows the JWT", async () => {
    github.post("/app/installations/9/access_tokens", () =>
      json({ message: "A JSON web token could not be decoded" }, 401),
    );
    const failure = installationTokens({ appId: 5551372, privateKey: pem })(9);
    await expect(failure).rejects.toThrow(GitHubError);
    await expect(failure).rejects.toThrow(
      /^minting a token for installation 9: 401 A JSON web token could not be decoded$/,
    );
  });
});
