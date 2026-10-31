import { createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { appEnvFileName, appJwt } from "./app.ts";

describe("appEnvFileName", () => {
  it.each([
    [undefined, ".env.github-app"],
    ["", ".env.github-app"],
    [".env.intenzo-app", ".env.intenzo-app"],
  ])("%j → %s", (value, name) => {
    expect(appEnvFileName(value)).toBe(name);
  });

  // Credentials must land in a file .gitignore's `.env.*` covers, at the repo root.
  it.each(["secrets.txt", ".env", ".env.example", "../.env.app", ".env.app/key", "env.app"])(
    "refuses %s",
    (value) => {
      expect(() => appEnvFileName(value)).toThrow(/gitignored \.env\.<name> file/);
    },
  );
});

describe("appJwt", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

  it("is an RS256 JWT issued by the App, backdated 60 s and valid for under 10 minutes", () => {
    const [header, payload] = appJwt("12345", pem, 1_000_000).split(".");
    expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(payload!)).toEqual({ iat: 999_940, exp: 1_000_540, iss: "12345" });
  });

  it("is signed with the App's private key", () => {
    const [header, payload, signature] = appJwt("12345", pem, 1_000_000).split(".");
    const ok = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, signature!, "base64url");
    expect(ok).toBe(true);
  });
});
