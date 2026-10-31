import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { deployments } from "../db/schema.ts";
import { resetWithDemoShop, testDb } from "../db/test-db.ts";
import { githubClient } from "../github/api.ts";
import { fakeGitHub, notFound } from "../github/fake-github.ts";
import type { PreviewRules } from "./match.ts";
import { findPreview, recordDeployment, storedPreviews } from "./store.ts";

const AT = new Date("2026-10-31T09:00:00.000Z");
const SHA = "b6b60c7dde267c69fe8febe6a4da332432896474";
const URL_A = "https://demo-shop-dly0m1skm-sumithprabhus-projects.vercel.app";
const URL_B = "https://demo-shop-hn43jguab-sumithprabhus-projects.vercel.app";
const REPO_PATH = "/repos/sumithprabhu/demo-shop";
const RULES: PreviewRules = {
  preview: { provider: "vercel", environment_prefix: "Preview" },
  prodDomains: [],
};

const github = fakeGitHub();
let t: Awaited<ReturnType<typeof testDb>>;
let repo: { id: number; fullName: string };

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  repo = await resetWithDemoShop(t.db);
});

const deployment = (fields: Partial<typeof deployments.$inferInsert>) => ({
  repoId: repo.id,
  sha: SHA,
  environment: "Preview",
  url: URL_A,
  state: "success",
  ghDeploymentId: 7_441_784_346,
  receivedAt: AT,
  ...fields,
});
const stored = () => t.db.select().from(deployments);

describe("recordDeployment", () => {
  it("keeps one row per commit and environment, with the latest URL", async () => {
    await recordDeployment(t.db, deployment({}));
    await recordDeployment(
      t.db,
      deployment({ url: URL_B, receivedAt: new Date(AT.getTime() + 1) }),
    );
    expect(await stored()).toMatchObject([{ url: URL_B, state: "success" }]);
  });

  it("never replaces a success with a failure, but does the reverse", async () => {
    await recordDeployment(t.db, deployment({}));
    await recordDeployment(t.db, deployment({ url: URL_B, state: "failure" }));
    expect(await stored()).toMatchObject([{ url: URL_A, state: "success" }]);

    await recordDeployment(t.db, deployment({ sha: "0a1b2c3", state: "error", url: null }));
    await recordDeployment(t.db, deployment({ sha: "0a1b2c3", url: URL_B }));
    const [, second] = await t.db.select().from(deployments).orderBy(deployments.id);
    expect(second).toMatchObject({ sha: "0a1b2c3", url: URL_B, state: "success" });
  });
});

describe("storedPreviews", () => {
  it("returns only previews Intenzo may use, by commit", async () => {
    await recordDeployment(t.db, deployment({ environment: "Production", url: URL_B }));
    await recordDeployment(t.db, deployment({ sha: "0a1b2c3", state: "failure" }));
    expect(await storedPreviews(t.db, repo.id, [SHA, "0a1b2c3"], RULES)).toEqual(new Map());

    await recordDeployment(t.db, deployment({}));
    expect(await storedPreviews(t.db, repo.id, [SHA, "0a1b2c3"], RULES)).toEqual(
      new Map([[SHA, URL_A]]),
    );
  });

  it("prefers the latest when several environments match", async () => {
    await recordDeployment(t.db, deployment({}));
    const later = new Date(AT.getTime() + 60_000);
    await recordDeployment(
      t.db,
      deployment({ environment: "Preview – demo-shop", url: URL_B, receivedAt: later }),
    );
    expect((await storedPreviews(t.db, repo.id, [SHA], RULES)).get(SHA)).toBe(URL_B);
  });
});

describe("findPreview", () => {
  const deps = () => ({ db: t.db, github: githubClient(async () => "ghs_test"), now: () => AT });

  it("uses a stored preview without asking GitHub", async () => {
    await recordDeployment(t.db, deployment({}));
    expect(await findPreview(deps(), repo, SHA, RULES)).toBe(URL_A);
    expect(github.calls).toEqual([]);
  });

  it("asks GitHub once when nothing is stored, skips production, and stores what it finds", async () => {
    github.get(`${REPO_PATH}/deployments`, [
      { id: 3, environment: "Production" },
      { id: 2, environment: "Preview" },
      { id: 1, environment: "Preview" },
    ]);
    github.get(`${REPO_PATH}/deployments/2/statuses`, [{ state: "failure", target_url: URL_B }]);
    github.get(`${REPO_PATH}/deployments/1/statuses`, [
      { state: "success", environment_url: URL_A, target_url: URL_A },
    ]);

    expect(await findPreview(deps(), repo, SHA, RULES)).toBe(URL_A);
    expect(github.calls).toEqual([
      `GET ${REPO_PATH}/deployments?sha=${SHA}&per_page=10`,
      `GET ${REPO_PATH}/deployments/2/statuses?per_page=1`,
      `GET ${REPO_PATH}/deployments/1/statuses?per_page=1`,
    ]);
    expect(await stored()).toMatchObject([
      { sha: SHA, environment: "Preview", url: URL_A, state: "success", ghDeploymentId: 1 },
    ]);
  });

  it("finds nothing when GitHub knows no preview of the commit", async () => {
    github.get(`${REPO_PATH}/deployments`, [{ id: 3, environment: "Production" }]);
    expect(await findPreview(deps(), repo, SHA, RULES)).toBeNull();
    github.get(`${REPO_PATH}/deployments`, notFound);
    expect(await findPreview(deps(), repo, SHA, RULES)).toBeNull();
    expect(await stored()).toEqual([]);
  });
});
