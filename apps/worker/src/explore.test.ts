import { describe, expect, it } from "vitest";

import { formatExplore, parseExploreArgs } from "./explore.ts";
import { UsageError } from "./record.ts";

describe("parseExploreArgs", () => {
  it("needs a criterion and a PR URL, and defaults the rest", () => {
    expect(
      parseExploreArgs([
        "--criterion",
        "fixtures/criteria/C2.json",
        "--pr",
        "http://localhost:3001",
      ]),
    ).toEqual({
      criterion: "fixtures/criteria/C2.json",
      pr: "http://localhost:3001",
      config: "packages/core/fixtures/config/demo-shop.intenzo.yml",
      steps: 25,
      model: "muse-wonder-1.0",
      hookSecretEnv: "DEMO_SHOP_HOOK_SECRET",
      bypassEnv: "DEMO_SHOP_BYPASS_SECRET",
    });
    expect(() => parseExploreArgs(["--pr", "http://x"])).toThrow(UsageError);
    expect(() => parseExploreArgs(["--criterion", "c.json", "--pr", "nope"])).toThrow(
      /must be a URL/,
    );
    expect(() =>
      parseExploreArgs(["--criterion", "c.json", "--pr", "http://x", "--steps", "0"]),
    ).toThrow(/--steps/);
  });
});

describe("formatExplore", () => {
  it("lists the steps and the outcome with the token count", () => {
    const text = formatExplore({
      status: "trigger_absent",
      reason: "no code field",
      steps: [{ n: 1, action: null, result: "ok, now on /cart", ok: true }],
      ms: 4200,
      modelCalls: 1,
      usage: { promptTokens: 900, cachedTokens: 0, completionTokens: 100, reasoningTokens: 60 },
    });
    expect(text).toBe(
      "   1. ok  ok, now on /cart\ntrigger_absent: no code field · 1 steps · 4.2 s · 1 model calls · 1000 tokens (900 in, 100 out, 60 reasoning)",
    );
  });
});
