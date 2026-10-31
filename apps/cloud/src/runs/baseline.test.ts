import { describe, expect, it } from "vitest";

import { githubClient } from "../github/api.ts";
import { fakeGitHub, notFound } from "../github/fake-github.ts";
import { type Baseline, describeBaseline, resolveBaseline } from "./baseline.ts";

const github = fakeGitHub();
const REPO = "sumithprabhu/demo-shop";
const HEAD = "2be4341844f9";
const COMPARE = `/repos/${REPO}/compare/main...${HEAD}`;
const urlOf = (sha: string) => `https://demo-shop-${sha}-sumithprabhus-projects.vercel.app`;

/**
 * main's history as first-parent chains: m5 is the merge base, m0 the oldest commit. A commit's
 * parents are read from the compare answer (the merge base) or the commits API (the rest).
 */
function mainHistory(parents: Record<string, string[]>, mergeBase = "m5") {
  const refs = (sha: string) => (parents[sha] ?? []).map((p) => ({ sha: p }));
  github.get(COMPARE, { merge_base_commit: { sha: mergeBase, parents: refs(mergeBase) } });
  for (const sha of Object.keys(parents)) {
    github.get(`/repos/${REPO}/commits/${sha}`, { sha, parents: refs(sha) });
  }
}
const LINEAR = { m5: ["m4"], m4: ["m3"], m3: ["m2"], m2: ["m1"], m1: ["m0"], m0: [] };

async function resolve(
  previewed: string[],
  maxDrift = 5,
  mode: "merge_base" | "none" = "merge_base",
) {
  const looked: string[] = [];
  const baseline = await resolveBaseline(
    {
      github: githubClient(async () => "ghs_test"),
      findPreview: async (sha) => {
        looked.push(sha);
        return previewed.includes(sha) ? urlOf(sha) : null;
      },
    },
    { repo: REPO, baseRef: "main", headSha: HEAD, baseline: { mode, max_drift_commits: maxDrift } },
  );
  return { baseline, looked };
}

describe("resolveBaseline (§17.3)", () => {
  it("uses the merge base's preview", async () => {
    mainHistory(LINEAR);
    const { baseline } = await resolve(["m5", "m4"]);
    expect(baseline).toEqual({ url: urlOf("m5"), sha: "m5", mergeBaseSha: "m5", drift: 0 });
    expect(github.calls).toEqual([`GET ${COMPARE}?per_page=1`]);
  });

  it("walks back to the nearest commit with a preview and reports the drift", async () => {
    mainHistory(LINEAR);
    const { baseline, looked } = await resolve(["m3", "m1"]);
    expect(baseline).toEqual({ url: urlOf("m3"), sha: "m3", mergeBaseSha: "m5", drift: 2 });
    expect(looked).toEqual(["m5", "m4", "m3"]);
    // The merge base's parents come with the compare answer.
    expect(github.calls).toEqual([`GET ${COMPARE}?per_page=1`, `GET /repos/${REPO}/commits/m4`]);
  });

  it("follows first parents only: a branch merged into main isn't main's history", async () => {
    mainHistory({ m5: ["m4", "side2"], m4: ["m3"], side2: ["side1"], m3: [] });
    expect((await resolve(["side2", "m3"])).baseline).toMatchObject({ sha: "m3", drift: 2 });
  });

  it("gives up past max_drift_commits, so the run continues without a baseline", async () => {
    mainHistory(LINEAR);
    const { baseline, looked } = await resolve(["m2"], 2);
    expect(baseline).toEqual({ url: null, reason: "no_preview", mergeBaseSha: "m5" });
    expect(looked).toEqual(["m5", "m4", "m3"]);
  });

  it("stops at the first commit of the history", async () => {
    mainHistory({ m1: ["m0"], m0: [] }, "m1");
    expect((await resolve([], 5)).baseline).toEqual({
      url: null,
      reason: "no_preview",
      mergeBaseSha: "m1",
    });
  });

  it("asks nothing when baseline.mode is none", async () => {
    expect((await resolve(["m5"], 5, "none")).baseline).toEqual({
      url: null,
      reason: "disabled",
      mergeBaseSha: null,
    });
    expect(github.calls).toEqual([]);
  });

  it("has no baseline when GitHub can't compare the branches", async () => {
    github.get(COMPARE, notFound);
    expect((await resolve(["m5"])).baseline).toEqual({
      url: null,
      reason: "no_merge_base",
      mergeBaseSha: null,
    });
  });
});

describe("describeBaseline", () => {
  const found = (drift: number): Baseline => ({
    url: urlOf("b6b60c7dde26"),
    sha: "b6b60c7dde267c69",
    mergeBaseSha: "x",
    drift,
  });

  it.each<[Baseline, string]>([
    [found(0), "main@b6b60c7 (the merge base)"],
    [found(1), "main@b6b60c7 (1 commit before the merge base)"],
    [found(2), "main@b6b60c7 (2 commits before the merge base)"],
    [{ url: null, reason: "disabled", mergeBaseSha: null }, "none (baseline.mode is none)"],
    [{ url: null, reason: "no_merge_base", mergeBaseSha: null }, "none (no merge base with main)"],
    [
      { url: null, reason: "no_preview", mergeBaseSha: "b6b60c7dde26" },
      "none (no preview of main@b6b60c7 or the commits before it)",
    ],
  ])("%j → %s", (baseline, text) => {
    expect(describeBaseline(baseline, "main")).toBe(text);
  });
});
