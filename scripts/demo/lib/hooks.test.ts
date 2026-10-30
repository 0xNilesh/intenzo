import { describe, expect, it } from "vitest";

import { hookHeaders, signHookCall } from "./hooks.ts";

// The same vector demo-shop's sign() produces (checked against it and openssl on 2026-10-30).
const VECTOR = "sha256=ee065af6cfe3770d5c02f44d58088593680886fd7cde1b8085e411ac66fb4f81";

describe("hook signing", () => {
  it("matches demo-shop's reference implementation", () => {
    expect(signHookCall("test-secret", "1800000000", JSON.stringify({ nonce: "n1" }))).toBe(VECTOR);
  });

  it("sends the timestamp it signed", () => {
    const headers = hookHeaders("test-secret", '{"nonce":"n1"}', 1_800_000_000);
    expect(headers).toEqual({
      "content-type": "application/json",
      "x-intenzo-timestamp": "1800000000",
      "x-intenzo-signature": VECTOR,
    });
  });
});
