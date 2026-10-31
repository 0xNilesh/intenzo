// Installations, repos and their config. Installation events aren't handled yet, so a repo is added
// the first time an event from it arrives: every event names its installation and repository.
import { IntenzoConfig } from "@intenzo/core";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { PreviewRules } from "../deployments/match.ts";
import type { Db } from "./db.ts";
import { installations, repos, runGroups } from "./schema.ts";

/** The parts of an event payload that name its repo and installation. */
export const RepoPayload = z.looseObject({
  installation: z.looseObject({ id: z.number() }),
  repository: z.looseObject({
    id: z.number(),
    full_name: z.string(),
    default_branch: z.string(),
    owner: z.looseObject({ login: z.string() }),
  }),
});
export type RepoPayload = z.infer<typeof RepoPayload>;

export type Repo = typeof repos.$inferSelect;

/** The event's repo, added or brought up to date (a rename, a new default branch). */
export async function ensureRepo(db: Db, payload: RepoPayload): Promise<Repo> {
  const { installation, repository } = payload;
  const [account] = await db
    .insert(installations)
    .values({ ghInstallationId: installation.id, account: repository.owner.login })
    .onConflictDoUpdate({
      target: installations.ghInstallationId,
      set: { account: sql`excluded.account` },
    })
    .returning();
  const [repo] = await db
    .insert(repos)
    .values({
      installationId: account!.id,
      ghRepoId: repository.id,
      fullName: repository.full_name,
      defaultBranch: repository.default_branch,
    })
    .onConflictDoUpdate({
      target: repos.ghRepoId,
      set: {
        installationId: sql`excluded.installation_id`,
        fullName: sql`excluded.full_name`,
        defaultBranch: sql`excluded.default_branch`,
      },
    })
    .returning();
  return repo!;
}

const DEFAULTS = IntenzoConfig.parse({ version: 1 });

/** The repo's validated .intenzo.yml, or the defaults until one has been read. */
export function repoConfig(repo: Repo): IntenzoConfig {
  return IntenzoConfig.safeParse(repo.configJson).data ?? DEFAULTS;
}

export async function saveConfig(db: Db, repoId: number, config: IntenzoConfig): Promise<Repo> {
  const [repo] = await db
    .update(repos)
    .set({ configJson: config })
    .where(eq(repos.id, repoId))
    .returning();
  return repo!;
}

export function previewRules(repo: Repo): PreviewRules {
  return { preview: repoConfig(repo).preview, prodDomains: repo.prodDomains };
}

/** The pull request's run group, created on its first event and open again when it's reopened. */
/** The PR's run group, opened again if it was closed. fromFork comes from its pull_request event. */
export async function ensureRunGroup(db: Db, repoId: number, prNumber: number, fromFork?: boolean) {
  const [group] = await db
    .insert(runGroups)
    .values({ repoId, prNumber, ...(fromFork !== undefined && { fromFork }) })
    .onConflictDoUpdate({
      target: [runGroups.repoId, runGroups.prNumber],
      set: { state: "open", ...(fromFork !== undefined && { fromFork }) },
    })
    .returning();
  return group!;
}
