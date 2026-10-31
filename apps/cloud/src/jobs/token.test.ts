import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { bearerToken, signJobToken, tokenExpiry, verifyJobToken } from "./token.ts";

const SECRET = "a-job-secret-for-tests-only-0123456789";
const CLAIMS = {
  jobId: "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b",
  runId: "ea44d35d-4baa-4f81-ac92-08285fae4058",
  exp: 2_000_000_000,
};
const NOW = 1_900_000_000;
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("job tokens (§8)", () => {
  it("round-trips the job, the run and the expiry", () => {
    expect(verifyJobToken(SECRET, signJobToken(SECRET, CLAIMS), NOW)).toEqual(CLAIMS);
  });

  it("expire 5 minutes after the job's deadline", () => {
    const deadline = new Date("2026-10-31T09:15:00.000Z");
    expect(tokenExpiry(deadline)).toBe(deadline.getTime() / 1000 + 300);
    const token = signJobToken(SECRET, { ...CLAIMS, exp: NOW + 10 });
    expect(verifyJobToken(SECRET, token, NOW + 9)).not.toBeNull();
    expect(verifyJobToken(SECRET, token, NOW + 10)).toBeNull();
  });

  it.each([
    ["another secret", () => signJobToken("another-secret-of-the-same-length-xxxxx", CLAIMS)],
    [
      "a changed payload",
      () => {
        const [h, , s] = signJobToken(SECRET, CLAIMS).split(".");
        return `${h}.${b64({ iss: "intenzo-cloud", sub: CLAIMS.jobId, run: CLAIMS.runId, exp: 9e9 })}.${s}`;
      },
    ],
    [
      "alg none",
      () => {
        const payload = b64({
          iss: "intenzo-cloud",
          sub: CLAIMS.jobId,
          run: CLAIMS.runId,
          exp: 9e9,
        });
        return `${b64({ alg: "none", typ: "JWT" })}.${payload}.`;
      },
    ],
    [
      "another algorithm, correctly signed",
      () => {
        const unsigned = `${b64({ alg: "HS512", typ: "JWT" })}.${b64({ iss: "intenzo-cloud", sub: CLAIMS.jobId, run: CLAIMS.runId, exp: 9e9 })}`;
        return `${unsigned}.${createHmac("sha256", SECRET).update(unsigned).digest("base64url")}`;
      },
    ],
    ["something that isn't a JWT", () => "ghs_not-a-real-token"],
    ["an empty string", () => ""],
  ])("refuses %s", (_name, token) => {
    expect(verifyJobToken(SECRET, token(), NOW)).toBeNull();
  });

  it("never verifies with an empty secret, and won't sign with one", () => {
    expect(verifyJobToken("", signJobToken(SECRET, CLAIMS), NOW)).toBeNull();
    expect(() => signJobToken("", CLAIMS)).toThrow();
  });

  it("reads the bearer token from the Authorization header", () => {
    const request = (value?: string) =>
      new Request("https://x", value ? { headers: { authorization: value } } : {});
    expect(bearerToken(request("Bearer abc.def.ghi"))).toBe("abc.def.ghi");
    expect(bearerToken(request("Basic abc"))).toBeNull();
    expect(bearerToken(request())).toBeNull();
  });
});
