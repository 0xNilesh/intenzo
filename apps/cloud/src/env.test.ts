import { describe, expect, it } from "vitest";

import { cloudEnv } from "./env.ts";

const VALID = {
  DATABASE_URL: "postgresql://user:pw-secret@db.example/intenzo",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_WEBHOOK_SECRET: "hook-secret-value",
};

describe("cloudEnv", () => {
  it("parses the settings, with the App id as a number", () => {
    expect(cloudEnv(VALID)).toEqual({ ...VALID, GITHUB_APP_ID: 123456 });
  });

  it.each([
    ["nothing set", {}, "DATABASE_URL, GITHUB_APP_ID, GITHUB_APP_WEBHOOK_SECRET"],
    ["an empty secret", { ...VALID, GITHUB_APP_WEBHOOK_SECRET: "" }, "GITHUB_APP_WEBHOOK_SECRET"],
    ["an App id that isn't a number", { ...VALID, GITHUB_APP_ID: "intenzo" }, "GITHUB_APP_ID"],
    ["an empty App id", { ...VALID, GITHUB_APP_ID: "" }, "GITHUB_APP_ID"],
  ])("names what's wrong with %s, without printing any value", (_name, env, names) => {
    let message = "";
    try {
      cloudEnv(env);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe(`Intenzo Cloud env vars missing or invalid: ${names}`);
    for (const value of Object.values(VALID)) expect(message).not.toContain(value);
  });
});
