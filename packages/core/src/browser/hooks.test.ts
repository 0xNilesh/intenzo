import { describe, expect, it } from "vitest";

import { hookHeaders, signHookCall } from "./hooks.ts";

// demo-shop's sign() and openssl produce this for ("test-secret", "1800000000", {"nonce":"n1"})
// (scripts/demo/lib/hooks.test.ts, checked on 2026-10-30). Matching it keeps both sides in step.
const VECTOR = "sha256=ee065af6cfe3770d5c02f44d58088593680886fd7cde1b8085e411ac66fb4f81";

describe("signHookCall", () => {
  it("matches demo-shop's reference implementation", () => {
    expect(signHookCall("test-secret", "1800000000", JSON.stringify({ nonce: "n1" }))).toBe(VECTOR);
  });

  it("covers the body: a different body gets a different signature", () => {
    expect(signHookCall("test-secret", "1800000000", '{"nonce":"n2"}')).not.toBe(VECTOR);
  });

  it("covers the timestamp: a different time gets a different signature", () => {
    expect(signHookCall("test-secret", "1800000001", '{"nonce":"n1"}')).not.toBe(VECTOR);
  });
});

describe("hookHeaders", () => {
  it("sends the timestamp it signed", () => {
    expect(hookHeaders("test-secret", '{"nonce":"n1"}', 1_800_000_000)).toEqual({
      "content-type": "application/json",
      "x-intenzo-timestamp": "1800000000",
      "x-intenzo-signature": VECTOR,
    });
  });
});
