import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_DENY_TEXT, IntenzoConfig } from "../schema/config.ts";
import { configNotes, denyText, isolationLevel } from "./derive.ts";
import { parseConfig } from "./load.ts";

const config = (input: Record<string, unknown>) => IntenzoConfig.parse({ version: 1, ...input });
const users = [{ username_secret: "QA_USER", password_secret: "QA_PASS" }];

describe("isolationLevel", () => {
  it("gives demo-shop ephemeral users through its session hook", () => {
    const text = readFileSync(
      new URL("../../fixtures/config/demo-shop.intenzo.yml", import.meta.url),
      "utf8",
    );
    const result = parseConfig(text);
    expect(result.ok && isolationLevel(result.config)).toBe("ephemeral_user");
  });

  it("is none when isolation is missing", () => {
    expect(isolationLevel(config({}))).toBe("none");
  });

  it("uses the reset hook only with a users pool", () => {
    expect(isolationLevel(config({ isolation: { reset_hook: "/api/test/reset", users } }))).toBe(
      "reset_hook",
    );
    expect(isolationLevel(config({ isolation: { reset_hook: "/api/test/reset" } }))).toBe("none");
  });

  it("prefers the session hook when both hooks are set", () => {
    const both = { session_hook: "/api/test/session", reset_hook: "/api/test/reset", users };
    expect(isolationLevel(config({ isolation: both }))).toBe("ephemeral_user");
  });
});

describe("configNotes", () => {
  it("warns when there's no isolation", () => {
    expect(configNotes(config({}))).toEqual([
      "no isolation: every verdict is capped at inconclusive. Add isolation.session_hook (§21.1)",
    ]);
  });

  it("points out a reset hook that can't be used", () => {
    expect(configNotes(config({ isolation: { reset_hook: "/api/test/reset" } }))[0]).toBe(
      "isolation.reset_hook does nothing without isolation.users (§21.1)",
    );
  });

  it("has nothing to say about a fully isolated config", () => {
    expect(configNotes(config({ isolation: { session_hook: "/api/test/session" } }))).toEqual([]);
  });
});

describe("denyText", () => {
  it("adds the repo's entries to the built-in list, lowercased and without duplicates", () => {
    const list = denyText(
      config({ guardrails: { deny_text: ["Delete Account", "pay", " Refund "] } }),
    );
    expect(list).toEqual([...DEFAULT_DENY_TEXT, "delete account", "refund"]);
  });

  it("can't drop the built-in entries", () => {
    expect(denyText(config({}))).toEqual([...DEFAULT_DENY_TEXT]);
  });
});
