// The baseline (§17.3): the preview of the commit a PR branched from on its base branch, so each
// criterion can be recorded before and after the change. Without one the run still verifies the
// PR, only without before/after.
import type { IntenzoConfig } from "@intenzo/core";
import { z } from "zod";

import { type GitHub, refPath } from "../github/api.ts";

export type Baseline =
  | {
      url: string;
      sha: string;
      mergeBaseSha: string;
      /** Commits between the merge base and `sha` on the base branch: 0 is the merge base itself. */
      drift: number;
    }
  | { url: null; reason: NoBaseline; mergeBaseSha: string | null };

/**
 * - `disabled`: baseline.mode is none
 * - `no_merge_base`: GitHub couldn't compare the branches (one was deleted, or they share no history)
 * - `no_preview`: neither the merge base nor its first max_drift_commits ancestors have a preview
 */
export type NoBaseline = "disabled" | "no_merge_base" | "no_preview";

export interface BaselineDeps {
  github: GitHub;
  /** A commit's usable preview: never production, never a production domain (deployments/). */
  findPreview: (sha: string) => Promise<string | null>;
}

export interface BaselineQuestion {
  repo: string;
  /** The PR's base branch. */
  baseRef: string;
  headSha: string;
  baseline: IntenzoConfig["baseline"];
}

const Parents = z.array(z.object({ sha: z.string() }));
// docs.github.com/en/rest/commits/commits#compare-two-commits. per_page=1 keeps the commit list short.
const Compare = z.object({ merge_base_commit: z.object({ sha: z.string(), parents: Parents }) });
// docs.github.com/en/rest/commits/commits#get-a-commit
const Commit = z.object({ parents: Parents });

export async function resolveBaseline(
  deps: BaselineDeps,
  question: BaselineQuestion,
): Promise<Baseline> {
  const { repo, baseRef, headSha, baseline } = question;
  if (baseline.mode === "none") return { url: null, reason: "disabled", mergeBaseSha: null };

  const compare = await deps.github.get(
    `/repos/${repo}/compare/${refPath(baseRef)}...${headSha}?per_page=1`,
    Compare,
  );
  if (!compare) return { url: null, reason: "no_merge_base", mergeBaseSha: null };
  const mergeBaseSha = compare.merge_base_commit.sha;

  // Walk the base branch's own history, first parents only, so commits merged in from other
  // branches don't count as drift.
  let sha = mergeBaseSha;
  let parents: z.infer<typeof Parents> | null = compare.merge_base_commit.parents;
  for (let drift = 0; ; drift++) {
    const url = await deps.findPreview(sha);
    if (url) return { url, sha, mergeBaseSha, drift };
    if (drift === baseline.max_drift_commits) break;
    parents ??= (await deps.github.get(`/repos/${repo}/commits/${sha}`, Commit))?.parents ?? [];
    const first = parents[0];
    if (!first) break;
    sha = first.sha;
    parents = null;
  }
  return { url: null, reason: "no_preview", mergeBaseSha };
}

/** How the log and, later, the report say it: "main@b6b60c7 (the merge base)". */
export function describeBaseline(baseline: Baseline, baseRef: string): string {
  if (baseline.url === null) {
    switch (baseline.reason) {
      case "disabled":
        return "none (baseline.mode is none)";
      case "no_merge_base":
        return `none (no merge base with ${baseRef})`;
      case "no_preview":
        return `none (no preview of ${baseRef}@${baseline.mergeBaseSha?.slice(0, 7)} or the commits before it)`;
    }
  }
  const at = `${baseRef}@${baseline.sha.slice(0, 7)}`;
  if (baseline.drift === 0) return `${at} (the merge base)`;
  const commits = baseline.drift === 1 ? "1 commit" : `${baseline.drift} commits`;
  return `${at} (${commits} before the merge base)`;
}
