// What the bench reads from GitHub about demo-shop, through the gh CLI (signed in).
import { spawnSync } from "node:child_process";

export const REPO = "sumithprabhu/demo-shop";

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
