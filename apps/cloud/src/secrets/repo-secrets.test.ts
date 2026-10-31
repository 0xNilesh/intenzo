import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { repos } from "../db/schema.ts";
import { resetWithDemoShop, testDb } from "../db/test-db.ts";
import { parseSecretsArgs, repoSecrets, setRepoSecrets } from "./repo-secrets.ts";
import { seal } from "./seal.ts";

const KEY = randomBytes(32);
const HOOK = "hook-secret-for-the-test-0123456789";
const BYPASS = "bypass-for-the-test-abcdefghijklmnop";

let t: Awaited<ReturnType<typeof testDb>>;
let repo: Awaited<ReturnType<typeof resetWithDemoShop>>;

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  repo = await resetWithDemoShop(t.db);
});

const row = async () => (await t.db.select().from(repos).where(eq(repos.id, repo.id)))[0]!;

describe("setRepoSecrets", () => {
  it("stores each secret sealed for the repo, and they open again", async () => {
    const stored = await setRepoSecrets(t.db, KEY, "sumithprabhu/demo-shop", {
      hookSecret: HOOK,
      bypass: BYPASS,
    });
    expect(stored).toEqual({ repo: "sumithprabhu/demo-shop", fields: ["hook_secret", "bypass"] });
    const saved = await row();
    expect(saved.hookSecretEnc).toMatch(/^v1\./);
    expect(JSON.stringify(saved)).not.toContain(HOOK);
    expect(JSON.stringify(saved)).not.toContain(BYPASS);
    expect(repoSecrets(KEY, saved)).toEqual({ hookSecret: HOOK, bypass: BYPASS });
  });

  it("changes only the secrets it's given", async () => {
    await setRepoSecrets(t.db, KEY, "sumithprabhu/demo-shop", { hookSecret: HOOK, bypass: BYPASS });
    await setRepoSecrets(t.db, KEY, "sumithprabhu/demo-shop", { bypass: "a-new-bypass-value" });
    expect(repoSecrets(KEY, await row())).toEqual({
      hookSecret: HOOK,
      bypass: "a-new-bypass-value",
    });
  });

  it("finds the repo whatever the case of its name, as GitHub does", async () => {
    await setRepoSecrets(t.db, KEY, "SumithPrabhu/Demo-Shop", { hookSecret: HOOK });
    expect(repoSecrets(KEY, await row()).hookSecret).toBe(HOOK);
  });

  it("refuses a repo Intenzo hasn't heard of", async () => {
    await expect(setRepoSecrets(t.db, KEY, "someone/else", { hookSecret: HOOK })).rejects.toThrow(
      "Intenzo has no repo someone/else",
    );
  });
});

describe("repoSecrets", () => {
  it("is empty for a repo without secrets", () => {
    expect(repoSecrets(KEY, { ...repo })).toEqual({});
  });

  it("opens the test users too", () => {
    const users = [{ username: "shopper", password: "pw-for-the-test" }];
    const usersEnc = seal(KEY, JSON.stringify(users), repo.ghRepoId, "users");
    expect(repoSecrets(KEY, { ...repo, usersEnc })).toEqual({ users });
  });

  it("won't open another repo's secrets", () => {
    const hookSecretEnc = seal(KEY, HOOK, repo.ghRepoId + 1, "hook_secret");
    expect(() => repoSecrets(KEY, { ...repo, hookSecretEnc })).toThrow(/didn't open/);
  });
});

describe("parseSecretsArgs", () => {
  const env = { DEMO_SHOP_HOOK_SECRET: HOOK, DEMO_SHOP_BYPASS_SECRET: BYPASS, EMPTY: "" };

  it("reads each secret from the env var it's named by", () => {
    expect(
      parseSecretsArgs(
        [
          "--repo",
          "sumithprabhu/demo-shop",
          "--hook-secret-env",
          "DEMO_SHOP_HOOK_SECRET",
          "--bypass-env",
          "DEMO_SHOP_BYPASS_SECRET",
        ],
        env,
      ),
    ).toEqual({ repo: "sumithprabhu/demo-shop", values: { hookSecret: HOOK, bypass: BYPASS } });
  });

  it.each([
    [["--hook-secret-env", "DEMO_SHOP_HOOK_SECRET"], "--repo owner/name is required"],
    [["--repo", "demo-shop", "--bypass-env", "DEMO_SHOP_BYPASS_SECRET"], "--repo owner/name"],
    [["--repo", "a/b"], "name at least one secret"],
    [["--repo", "a/b", "--bypass-env", "EMPTY"], "EMPTY isn't set"],
    [["--repo", "a/b", "--bypass-env", "MISSING"], "MISSING isn't set"],
    [["--repo", "a/b", "--bypass", "inline-value"], "Unknown option"],
  ])("refuses %j", (argv, message) => {
    expect(() => parseSecretsArgs(argv, env)).toThrow(message);
  });
});
