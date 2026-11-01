import { describe, expect, it } from "vitest";

import { DEFAULT_DENY_TEXT, IntenzoConfig } from "./config.ts";
import { issues } from "./test-helpers.ts";

// demo-shop's config, as ARCHITECTURE §10 describes it.
const demoShop = {
  version: 1,
  preview: { provider: "vercel", environment_prefix: "Preview", project: "demo-shop" },
  baseline: { mode: "merge_base", max_drift_commits: 5 },
  start: { default: "/" },
  isolation: { session_hook: "/api/test/session", reset_hook: "/api/test/reset" },
  data: ["valid discount code: SAVE10", "expired discount code: OLD5"],
  guardrails: { deny_text: ["delete account"], extra_navigation_origins: [] },
  judge: { require_agreement: true },
  policy: {
    run_on: ["ready_for_review", "preview_ready"],
    inconclusive_conclusion: "neutral",
    approvers: ["pm-alice", "@org/product"],
    agent_handle: "@intenzo-fixer",
    agent_trigger: "button",
    max_agent_attempts: 3,
    allow_forks: false,
  },
  tests: { export: "suggest", dir: "tests/intenzo" },
};

describe("IntenzoConfig", () => {
  it("parses demo-shop's full config", () => {
    expect(IntenzoConfig.parse(demoShop).isolation.session_hook).toBe("/api/test/session");
  });

  it("fills every section's defaults from just a version", () => {
    const config = IntenzoConfig.parse({ version: 1 });
    expect(config.preview).toEqual({ provider: "vercel", environment_prefix: "Preview" });
    expect(config.baseline).toEqual({ mode: "merge_base", max_drift_commits: 5 });
    expect(config.start.default).toBe("/");
    expect(config.judge.require_agreement).toBe(true);
    expect(config.policy).toMatchObject({
      inconclusive_conclusion: "neutral",
      agent_trigger: "button",
      max_agent_attempts: 3,
      allow_forks: false,
    });
    expect(config.tests).toEqual({ export: "suggest", dir: "tests/intenzo" });
    expect(config.isolation).toEqual({});
  });

  it("fills inner defaults when a section is only partly written", () => {
    const config = IntenzoConfig.parse({ version: 1, policy: { approvers: ["pm-alice"] } });
    expect(config.policy.max_agent_attempts).toBe(3);
    expect(config.policy.approvers).toEqual(["pm-alice"]);
  });

  it("requires version 1", () => {
    expect(issues(IntenzoConfig, {})[0]).toMatch(/^version: /);
    expect(issues(IntenzoConfig, { version: 2 })[0]).toMatch(/^version: /);
  });

  it("names unknown keys, at the top level and inside sections", () => {
    expect(issues(IntenzoConfig, { version: 1, baseline_mode: "none" })).toEqual([
      '(root): Unrecognized key: "baseline_mode"',
    ]);
    expect(issues(IntenzoConfig, { version: 1, policy: { auto_merge: true } })).toEqual([
      'policy: Unrecognized key: "auto_merge"',
    ]);
  });

  it("never accepts credentials in the file, only secret names", () => {
    const raw = { version: 1, isolation: { users: [{ username: "qa", password: "hunter2" }] } };
    expect(issues(IntenzoConfig, raw).join("\n")).toMatch(/isolation\.users\.0: Unrecognized keys/);
    const lowercase = {
      version: 1,
      isolation: { users: [{ username_secret: "qa_user", password_secret: "QA_PASS" }] },
    };
    expect(issues(IntenzoConfig, lowercase)).toEqual([
      "isolation.users.0.username_secret: must name a stored secret (e.g. INTENZO_USER_1), never contain the value",
    ]);
  });

  it.each([
    ["https://evil.example/api/test/session"],
    ["//evil.example/hook"],
    ["api/test/session"],
  ])("keeps hooks on the app's own origin: rejects %j", (hook) => {
    expect(issues(IntenzoConfig, { version: 1, isolation: { session_hook: hook } })).toEqual([
      "isolation.session_hook: must be a path on the app's own origin",
    ]);
  });

  it("needs a users pool for form login", () => {
    const formOnly = {
      version: 1,
      isolation: { form_login: { url: "/login", user_label: "Email", pass_label: "Password" } },
    };
    expect(issues(IntenzoConfig, formOnly)).toEqual([
      "isolation.users: form_login needs a users pool to log in with",
    ]);
  });

  it("bounds agent attempts and drift", () => {
    expect(issues(IntenzoConfig, { version: 1, policy: { max_agent_attempts: 0 } })[0]).toMatch(
      /^policy\.max_agent_attempts: /,
    );
    expect(issues(IntenzoConfig, { version: 1, baseline: { max_drift_commits: -1 } })[0]).toMatch(
      /^baseline\.max_drift_commits: /,
    );
  });

  it("rejects an agent handle that isn't a GitHub handle", () => {
    expect(
      issues(IntenzoConfig, { version: 1, policy: { agent_handle: "intenzo-fixer" } }),
    ).toEqual(["policy.agent_handle: must be a GitHub handle like @intenzo-fixer"]);
  });

  it("has no production baseline option (§10)", () => {
    expect(issues(IntenzoConfig, { version: 1, baseline: { mode: "production" } })[0]).toMatch(
      /^baseline\.mode: /,
    );
  });
});

describe("guardrails.allow_text (§29)", () => {
  const withHook = { session_hook: "/api/test/session" };

  it("takes built-in terms out where every lane has its own user", () => {
    const config = IntenzoConfig.parse({
      version: 1,
      isolation: withHook,
      guardrails: { allow_text: ["Remove"] },
    });
    expect(config.guardrails.allow_text).toEqual(["Remove"]);
    expect(IntenzoConfig.parse({ version: 1 }).guardrails.allow_text).toEqual([]);
  });

  it("allows only built-in terms, so a typo can't pass for an allowance", () => {
    const input = {
      version: 1,
      isolation: withHook,
      guardrails: { allow_text: ["remove", "rmove"] },
    };
    expect(issues(IntenzoConfig, input)).toEqual([
      expect.stringMatching(/^guardrails\.allow_text\.1: "rmove" isn't a built-in term/),
    ]);
  });

  it("needs isolation: an allowed action may only touch a throwaway user's data", () => {
    const allow = { allow_text: ["remove"] };
    expect(issues(IntenzoConfig, { version: 1, guardrails: allow })).toEqual([
      "guardrails.allow_text: needs isolation: a session_hook, or a reset_hook with users",
    ]);
    // A reset hook isolates only with a users pool to reset (§21.1).
    const resetOnly = { reset_hook: "/api/test/reset" };
    expect(
      issues(IntenzoConfig, { version: 1, isolation: resetOnly, guardrails: allow }),
    ).toHaveLength(1);
    const pool = {
      ...resetOnly,
      users: [{ username_secret: "QA_USER", password_secret: "QA_PASS" }],
    };
    expect(issues(IntenzoConfig, { version: 1, isolation: pool, guardrails: allow })).toEqual([]);
  });
});

describe("DEFAULT_DENY_TEXT", () => {
  it("covers the destructive actions from §29", () => {
    expect(DEFAULT_DENY_TEXT).toEqual(
      expect.arrayContaining(["delete", "pay", "purchase", "place order", "transfer"]),
    );
  });
});
