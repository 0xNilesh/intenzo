import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { open, seal, secretsKey } from "./seal.ts";

const KEY = randomBytes(32);
const DEMO_SHOP = 1_088_563_216;
const HOOK = "hook-secret-for-the-test-0123456789";

describe("seal and open (§29)", () => {
  it.each(["hook_secret", "bypass", "users"] as const)("round-trips a %s", (field) => {
    const sealed = seal(KEY, HOOK, DEMO_SHOP, field);
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain(HOOK);
    expect(open(KEY, sealed, DEMO_SHOP, field)).toBe(HOOK);
  });

  it("uses a fresh IV every time, so equal secrets don't look equal", () => {
    expect(seal(KEY, HOOK, DEMO_SHOP, "bypass")).not.toBe(seal(KEY, HOOK, DEMO_SHOP, "bypass"));
  });

  it("won't open a value sealed for another repo or another column", () => {
    const sealed = seal(KEY, HOOK, DEMO_SHOP, "hook_secret");
    expect(() => open(KEY, sealed, DEMO_SHOP + 1, "hook_secret")).toThrow(/didn't open/);
    expect(() => open(KEY, sealed, DEMO_SHOP, "bypass")).toThrow(/didn't open/);
  });

  it("won't open with another key, or after any part was changed", () => {
    const sealed = seal(KEY, HOOK, DEMO_SHOP, "bypass");
    expect(() => open(randomBytes(32), sealed, DEMO_SHOP, "bypass")).toThrow(/didn't open/);
    const parts = sealed.split(".");
    for (const i of [1, 2, 3]) {
      const changed = [...parts];
      const bytes = Buffer.from(changed[i]!, "base64url");
      bytes[0] = bytes[0]! ^ 1;
      changed[i] = bytes.toString("base64url");
      expect(() => open(KEY, changed.join("."), DEMO_SHOP, "bypass")).toThrow(/didn't open/);
    }
  });

  it("names no secret when it fails", () => {
    const sealed = seal(KEY, HOOK, DEMO_SHOP, "bypass");
    try {
      open(randomBytes(32), sealed, DEMO_SHOP, "bypass");
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(HOOK);
      expect(String(err)).not.toContain(sealed);
    }
  });

  it.each(["", "v2.a.b.c", "v1.a.b", "not sealed at all"])("refuses %j as a sealed value", (s) => {
    expect(() => open(KEY, s, DEMO_SHOP, "bypass")).toThrow(/isn't a sealed secret|didn't open/);
  });
});

describe("secretsKey", () => {
  it("takes 32 bytes, base64", () => {
    expect(secretsKey(KEY.toString("base64")).equals(KEY)).toBe(true);
  });

  it.each([randomBytes(16).toString("base64"), "not base64 at all!", ""])("refuses %j", (value) => {
    expect(() => secretsKey(value)).toThrow(/32 bytes/);
  });
});
