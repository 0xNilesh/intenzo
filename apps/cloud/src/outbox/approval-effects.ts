// The outbox's approval effects (§26.2, T5.5): the commit status that records product approval,
// and the reply to someone who can't approve.
import { eq } from "drizzle-orm";
import { z } from "zod";

import { APPROVAL_CONTEXT } from "../approval/approve.ts";
import type { Db } from "../db/db.ts";
import { installations, repos, runGroups, runs } from "../db/schema.ts";
import type { GitHub } from "../github/api.ts";
import type { EffectExecutor, OutboxRow } from "./drain.ts";

export interface ApprovalEffectDeps {
  db: Db;
  /** A client acting as the App's installation. */
  github: (installationId: number) => GitHub;
  reportBaseUrl: string;
}

export function approvalExecutors(deps: ApprovalEffectDeps): Record<string, EffectExecutor> {
  return { approval: approvalExecutor(deps), reply: replyExecutor(deps) };
}

const Id = z.object({ id: z.number() });

async function groupOf(db: Db, row: OutboxRow) {
  const [ctx] = await db
    .select({ group: runGroups, repo: repos, installation: installations })
    .from(runGroups)
    .innerJoin(repos, eq(runGroups.repoId, repos.id))
    .innerJoin(installations, eq(repos.installationId, installations.id))
    .where(eq(runGroups.id, row.groupId!));
  if (!ctx) throw new Error(`run group ${row.groupId} doesn't exist`);
  return ctx;
}

/** §26.2: `Intenzo / product approval = success` on the run's commit, naming the approver. */
export function approvalExecutor(deps: ApprovalEffectDeps): EffectExecutor {
  return {
    run: async (row) => {
      const { login } = row.payloadJson as { login: string };
      const { repo, installation } = await groupOf(deps.db, row);
      const [run] = await deps.db.select().from(runs).where(eq(runs.id, row.runId!));
      if (!run) throw new Error(`run ${row.runId} doesn't exist`);
      // docs.github.com/en/rest/commits/statuses#create-a-commit-status
      const status = await deps.github(installation.ghInstallationId).send(
        "POST",
        `/repos/${repo.fullName}/statuses/${run.headSha}`,
        {
          state: "success",
          context: APPROVAL_CONTEXT,
          description: `Approved by ${login}`.slice(0, 140),
          target_url: `${deps.reportBaseUrl.replace(/\/$/, "")}/r/${run.id}`,
        },
        Id,
      );
      if (!status) throw new Error("GitHub answered 404: the repo or commit isn't reachable");
      return String(status.id);
    },
  };
}

/** A reply on the pull request, to someone who can't approve. */
export function replyExecutor(deps: ApprovalEffectDeps): EffectExecutor {
  return {
    run: async (row) => {
      const { body } = row.payloadJson as { body: string };
      const { group, repo, installation } = await groupOf(deps.db, row);
      const comment = await deps
        .github(installation.ghInstallationId)
        .send("POST", `/repos/${repo.fullName}/issues/${group.prNumber}/comments`, { body }, Id);
      if (!comment) throw new Error("GitHub answered 404: the repo or PR isn't reachable");
      return String(comment.id);
    },
  };
}
