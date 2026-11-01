// The outbox's agent effects (§26.3): the fix request comment that mentions the repo's fixer
// agent, and the `needs-human` label once the agent has had its attempts.
import { eq } from "drizzle-orm";
import { z } from "zod";

import { renderFixerComment } from "@intenzo/core/fixer";

import { fixerPayload } from "../agent/fix-request.ts";
import type { Db } from "../db/db.ts";
import { installations, repos, runGroups } from "../db/schema.ts";
import type { GitHub } from "../github/api.ts";
import type { EffectExecutor, OutboxRow } from "./drain.ts";

export interface AgentEffectDeps {
  db: Db;
  /** A client acting as the App's installation. */
  github: (installationId: number) => GitHub;
  reportBaseUrl: string;
  /** Signs the requests (INTENZO_FIXER_SECRET); the repo's fixer checks them with the same. */
  fixerSecret: string | null;
}

export function agentExecutors(deps: AgentEffectDeps): Record<string, EffectExecutor> {
  return { agent: agentExecutor(deps), label: labelExecutor(deps) };
}

const Id = z.object({ id: z.number() });
// docs.github.com/en/rest/issues/labels#add-labels-to-an-issue
const Labels = z.array(z.object({ name: z.string() }));

/** The group's pull request and how to reach it. */
async function pullOf(db: Db, row: OutboxRow) {
  const [ctx] = await db
    .select({ group: runGroups, repo: repos, installation: installations })
    .from(runGroups)
    .innerJoin(repos, eq(runGroups.repoId, repos.id))
    .innerJoin(installations, eq(repos.installationId, installations.id))
    .where(eq(runGroups.id, row.groupId!));
  if (!ctx) throw new Error(`run group ${row.groupId} doesn't exist`);
  return ctx;
}

/**
 * §26.3: the signed fix request, as a comment the fixer's workflow picks up. At most once: a
 * repeat would start a second paid fixer run, so a crash loses the request instead (§16.4).
 */
export function agentExecutor(deps: AgentEffectDeps): EffectExecutor {
  return {
    atMostOnce: true,
    run: async (row) => {
      if (!deps.fixerSecret) {
        throw new Error("INTENZO_FIXER_SECRET isn't set, so no fix request can be signed");
      }
      const { group, repo, installation } = await pullOf(deps.db, row);
      const payload = await fixerPayload(deps.db, row.runId!, deps.reportBaseUrl, deps.fixerSecret);
      const comment = await deps
        .github(installation.ghInstallationId)
        .send(
          "POST",
          `/repos/${repo.fullName}/issues/${group.prNumber}/comments`,
          { body: renderFixerComment(payload) },
          Id,
        );
      if (!comment) throw new Error("GitHub answered 404: the repo or PR isn't reachable");
      return String(comment.id);
    },
  };
}

/** §26.3: label the pull request; GitHub creates the label the first time it's used. */
export function labelExecutor(deps: AgentEffectDeps): EffectExecutor {
  return {
    run: async (row) => {
      const { name } = row.payloadJson as { name: string };
      const { group, repo, installation } = await pullOf(deps.db, row);
      await deps
        .github(installation.ghInstallationId)
        .send(
          "POST",
          `/repos/${repo.fullName}/issues/${group.prNumber}/labels`,
          { labels: [name] },
          Labels,
        );
      return null;
    },
  };
}
