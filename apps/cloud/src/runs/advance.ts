// advance() (§16.4): load a run group, let decide() work out what a fact changes, and write the
// result, all in one transaction holding the group's row lock, so two events for one pull request
// can't interleave. The decision's effects are written to the outbox in the same transaction, so
// a crash can't separate a run's change from what it has to tell GitHub (T2.4).
import { eq } from "drizzle-orm";

import type { Db } from "../db/db.ts";
import { previewRules, repoConfig } from "../db/repos.ts";
import { repos, runGroups, runs } from "../db/schema.ts";
import { storedPreviews } from "../deployments/store.ts";
import { enqueueEffects } from "../outbox/rows.ts";
import { type Clock, decide, type Decision, type Fact, type Run } from "./transition.ts";

export async function advance(
  db: Db,
  groupId: number,
  fact: Fact,
  clock: Clock,
): Promise<Decision> {
  return db.transaction(async (tx) => {
    const [group] = await tx
      .select()
      .from(runGroups)
      .where(eq(runGroups.id, groupId))
      .for("update");
    if (!group) throw new Error(`run group ${groupId} doesn't exist`);
    const [repo] = await tx.select().from(repos).where(eq(repos.id, group.repoId));
    const rows = await tx.select().from(runs).where(eq(runs.runGroupId, groupId));

    const groupRuns = rows.map(toRun);
    // The previews decide() may need: its runs' commits and the fact's.
    const shas = new Set(groupRuns.map((r) => r.headSha));
    const sha = factSha(fact);
    if (sha) shas.add(sha);
    const decision = decide(
      {
        id: groupId,
        runs: groupRuns,
        previews: await storedPreviews(tx, repo!.id, [...shas], previewRules(repo!)),
        inconclusiveConclusion: repoConfig(repo!).policy.inconclusive_conclusion,
      },
      fact,
      clock,
    );

    if (decision.created.length > 0) {
      await tx
        .insert(runs)
        .values(decision.created.map((run) => ({ ...run, runGroupId: groupId })));
    }
    for (const run of decision.updated) {
      const { state, outcome, outcomeReason, prUrl, startedAt, deadlineAt, finishedAt } = run;
      await tx
        .update(runs)
        .set({ state, outcome, outcomeReason, prUrl, startedAt, deadlineAt, finishedAt })
        .where(eq(runs.id, run.id));
    }
    await enqueueEffects(tx, groupId, decision.effects);
    return decision;
  });
}

function factSha(fact: Fact): string | null {
  switch (fact.kind) {
    case "pr_ready":
    case "pr_pushed":
      return fact.headSha;
    case "preview_ready":
    case "preview_failed":
      return fact.sha;
    case "tick":
    case "job_finished":
    case "job_failed":
      return null;
  }
}

function toRun(row: typeof runs.$inferSelect): Run {
  return {
    id: row.id,
    headSha: row.headSha,
    attemptNo: row.attemptNo,
    trigger: row.trigger,
    state: row.state,
    outcome: row.outcome,
    outcomeReason: row.outcomeReason,
    prUrl: row.prUrl,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    deadlineAt: row.deadlineAt,
    finishedAt: row.finishedAt,
  };
}
