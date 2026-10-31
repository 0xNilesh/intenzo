// Deployments by commit (§11, §16.2). Every deployment_status is stored. A commit's preview is looked
// up in the table first, then once through GitHub's deployments API, storing what that finds, so a
// preview deployed before the App was installed, or whose webhook was lost, still counts.
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../db/db.ts";
import { deployments } from "../db/schema.ts";
import type { GitHub } from "../github/api.ts";
import {
  deploymentUrl,
  FINAL_STATES,
  isPreviewEnvironment,
  previewUrl,
  type PreviewRules,
} from "./match.ts";

export type NewDeployment = typeof deployments.$inferInsert;

/**
 * Stores a deployment's latest state for its commit and environment. A failure never replaces a
 * stored success: that earlier deployment still serves the commit at its URL.
 */
export async function recordDeployment(db: Db, deployment: NewDeployment): Promise<void> {
  await db
    .insert(deployments)
    .values(deployment)
    .onConflictDoUpdate({
      target: [deployments.repoId, deployments.sha, deployments.environment],
      set: {
        url: sql`excluded.url`,
        state: sql`excluded.state`,
        ghDeploymentId: sql`excluded.gh_deployment_id`,
        receivedAt: sql`excluded.received_at`,
      },
      setWhere: sql`${deployments.state} <> 'success' or excluded.state = 'success'`,
    });
}

/** The usable previews of these commits, by SHA. The latest wins when several environments match. */
export async function storedPreviews(
  db: Db,
  repoId: number,
  shas: readonly string[],
  rules: PreviewRules,
): Promise<Map<string, string>> {
  const previews = new Map<string, string>();
  if (shas.length === 0) return previews;
  const rows = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.repoId, repoId),
        inArray(deployments.sha, [...shas]),
        eq(deployments.state, "success"),
      ),
    )
    .orderBy(desc(deployments.receivedAt));
  for (const row of rows) {
    const url = previewUrl(row, rules);
    if (url && !previews.has(row.sha)) previews.set(row.sha, url);
  }
  return previews;
}

// docs.github.com/en/rest/deployments/deployments#list-deployments and
// …/deployments/statuses#list-deployment-statuses: both newest first.
const Deployments = z.array(z.object({ id: z.number(), environment: z.string() }));
const Statuses = z.array(
  z.object({
    state: z.string(),
    environment_url: z.string().nullish(),
    target_url: z.string().nullish(),
  }),
);
/** How many of a commit's deployments the API lookup reads, newest first. */
const API_DEPLOYMENTS = 10;

export interface PreviewLookup {
  db: Db;
  github: GitHub;
  now: () => Date;
}

/** A commit's usable preview (§16.2): the table, else GitHub's deployments API once. */
export async function findPreview(
  deps: PreviewLookup,
  repo: { id: number; fullName: string },
  sha: string,
  rules: PreviewRules,
): Promise<string | null> {
  const stored = (await storedPreviews(deps.db, repo.id, [sha], rules)).get(sha);
  if (stored) return stored;

  const query = new URLSearchParams({ sha, per_page: String(API_DEPLOYMENTS) });
  const listed = await deps.github.get(`/repos/${repo.fullName}/deployments?${query}`, Deployments);
  for (const deployment of listed ?? []) {
    // A production deployment is skipped before its status is even read.
    if (!isPreviewEnvironment(deployment.environment, rules.preview)) continue;
    const [status] =
      (await deps.github.get(
        `/repos/${repo.fullName}/deployments/${deployment.id}/statuses?per_page=1`,
        Statuses,
      )) ?? [];
    if (!status || !FINAL_STATES.has(status.state)) continue;
    const row = {
      repoId: repo.id,
      sha,
      environment: deployment.environment,
      url: deploymentUrl(status),
      state: status.state,
      ghDeploymentId: deployment.id,
      receivedAt: deps.now(),
    };
    await recordDeployment(deps.db, row);
    const url = previewUrl(row, rules);
    if (url) return url;
  }
  return null;
}
