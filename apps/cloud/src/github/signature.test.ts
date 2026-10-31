import { describe, expect, it } from "vitest";

import { signWebhook, verifyWebhookSignature } from "./signature.ts";

// GitHub's own test vector (docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
const DOCS = {
  secret: "It's a Secret to Everybody",
  body: "Hello, World!",
  header: "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
};

describe("signWebhook", () => {
  it("matches GitHub's documented test vector", () => {
    expect(signWebhook(DOCS.secret, DOCS.body)).toBe(DOCS.header);
  });

  it("hashes a string as its UTF-8 bytes", () => {
    const body = '{"title":"Réductions 👋"}';
    expect(signWebhook("s", body)).toBe(signWebhook("s", Buffer.from(body, "utf8")));
  });
});

describe("verifyWebhookSignature", () => {
  const bytes = new TextEncoder().encode(DOCS.body);

  it.each([
    ["the documented vector", DOCS.secret, DOCS.body, DOCS.header, true],
    ["the same body as bytes", DOCS.secret, bytes, DOCS.header, true],
    ["a different secret", "another secret", DOCS.body, DOCS.header, false],
    ["a changed body", DOCS.secret, "Hello, World?", DOCS.header, false],
    ["no header", DOCS.secret, DOCS.body, null, false],
    ["an empty header", DOCS.secret, DOCS.body, "", false],
    ["the digest without its prefix", DOCS.secret, DOCS.body, DOCS.header.slice(7), false],
    ["a SHA-1 style prefix", DOCS.secret, DOCS.body, `sha1=${DOCS.header.slice(7)}`, false],
    ["a truncated digest", DOCS.secret, DOCS.body, DOCS.header.slice(0, -2), false],
    [
      "upper-case hex (GitHub sends lower case)",
      DOCS.secret,
      DOCS.body,
      `sha256=${DOCS.header.slice(7).toUpperCase()}`,
      false,
    ],
    // An unset secret must not turn into "HMAC with an empty key", which anyone can compute.
    ["an empty secret", "", DOCS.body, signWebhook("", DOCS.body), false],
  ] as const)("%s", (_name, secret, body, header, expected) => {
    expect(verifyWebhookSignature(secret, body, header)).toBe(expected);
  });
});
