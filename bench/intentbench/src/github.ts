// What the bench reads from GitHub about demo-shop, through the gh CLI (signed in): a branch's
// Vercel preview, and its diff against the base every case branched from.
import { spawnSync } from "node:child_process";

import { ContextBundle } from "@intenzo/core";
import { z } from "zod";

export const REPO = "sumithprabhu/demo-shop";
/** main when the cases were made (T6.1): every bench branch starts here, and the base takes run on its preview. */
export const BASE_SHA = "83d338a2ec3c0609c4addbd60e4a8fd76a23860a";
/** As the Cloud's context bundle cuts them (§8). */
const MAX_PATCH_LINES = 400;

/** `gh api <path> --jq <jq>`'s output, or "" when it fails. */
export function gh(path: string, jq: string): string {
  const r = spawnSync("gh", ["api", path, "--jq", jq], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

/** The newest successful Preview deployment of a branch or commit. */
export function previewOf(ref: string): string | null {
  const sha = gh(`repos/${REPO}/commits/${ref}`, ".sha");
  const id = sha
    ? gh(
        `repos/${REPO}/deployments?sha=${sha}&per_page=10`,
        '[.[] | select(.environment | startswith("Preview"))][0].id',
      )
    : "";
  const url = id
    ? gh(
        `repos/${REPO}/deployments/${id}/statuses`,
        '[.[] | select(.state == "success")][0].environment_url',
      )
    : "";
  return url && url !== "null" ? url : null;
}

/** A case's diff, in the context bundle's shape (§8): what arm A reviews. */
export const BenchDiff = z.strictObject({
  base: z.string(),
  head: z.string(),
  files: ContextBundle.shape.diff.shape.files,
});
export type BenchDiff = z.infer<typeof BenchDiff>;

// docs.github.com/en/rest/commits/commits#compare-two-commits
const Compare = z.looseObject({
  commits: z.array(z.looseObject({ sha: z.string() })),
  files: z.array(
    z.looseObject({
      filename: z.string(),
      status: ContextBundle.shape.diff.shape.files.element.shape.status,
      additions: z.number(),
      deletions: z.number(),
      patch: z.string().optional(),
    }),
  ),
});

/** What `branch` changes since BASE_SHA. */
export function diffOf(branch: string): BenchDiff {
  const r = spawnSync("gh", ["api", `repos/${REPO}/compare/${BASE_SHA}...${branch}`], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`gh couldn't compare ${branch}: ${r.stderr.trim()}`);
  const compare = Compare.parse(JSON.parse(r.stdout));
  const head = compare.commits.at(-1)?.sha;
  if (!head) throw new Error(`${branch} has no commits since ${BASE_SHA}`);
  return BenchDiff.parse({
    base: BASE_SHA,
    head,
    files: compare.files.map((f) => ({
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      ...(f.patch !== undefined && {
        patch: f.patch.split("\n").slice(0, MAX_PATCH_LINES).join("\n"),
      }),
    })),
  });
}
