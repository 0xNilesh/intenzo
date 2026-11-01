// Send to agent (§26.2, §26.3): a press of the button on a failed run's check run asks the repo's
// fixer agent for a fix, through the outbox. One request per run, numbered per run group by an
// atomic counter (outbox key agent:{group}:{n}), and never more than the repo's max_agent_attempts.
import { and, eq } from "drizzle-orm";

import { CoverageMap, CriterionSet, describeStep, type LaneResult } from "@intenzo/core";
import { buildFixerPayload, type FixerPayload } from "@intenzo/core/fixer";

import type { Db } from "../db/db.ts";
import { repoConfig } from "../db/repos.ts";
import { criteriaResults, intentVersions, outbox, repos, runGroups, runs } from "../db/schema.ts";
import { agentAttemptsLeft, readingParts, shownRun, type StoredEvidence } from "../report/model.ts";

export type FixRequest = { sent: number } | { skipped: string };

/** Queues the fix request for a failed run, or says why not. Two presses never send two. */
export function requestFix(db: Db, runId: string): Promise<FixRequest> {
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
    if (!run) return { skipped: "no such run" };
    // The group's row lock: two presses (two webhook deliveries) take turns, as events do (§16.4).
    const [group] = await tx
      .select()
      .from(runGroups)
      .where(eq(runGroups.id, run.runGroupId))
      .for("update");
    const [repo] = await tx.select().from(repos).where(eq(repos.id, group!.repoId));
    // §26.2: the handler re-checks what the button was offered for.
    if (run.state !== "done" || run.outcome !== "fail") {
      return { skipped: `the run ${run.state === "done" ? `ended ${run.outcome}` : "isn't done"}` };
    }
    const groupRuns = await tx.select().from(runs).where(eq(runs.runGroupId, group!.id));
    if (shownRun(groupRuns)?.id !== run.id) return { skipped: "a newer run replaced it" };
    const policy = repoConfig(repo!).policy;
    if (agentAttemptsLeft(policy, group!.agentAttempts) === 0) {
      return {
        skipped: !policy.agent_handle
          ? "the repo has no fixer agent"
          : policy.agent_trigger !== "button"
            ? "the repo's agent is triggered automatically"
            : "the agent's attempts are used up",
      };
    }
    const [sent] = await tx
      .select({ id: outbox.id })
      .from(outbox)
      .where(and(eq(outbox.effect, "agent"), eq(outbox.runId, run.id)))
      .limit(1);
    if (sent) return { skipped: "this run's fix was already requested" };

    const n = group!.agentAttempts + 1;
    await tx.update(runGroups).set({ agentAttempts: n }).where(eq(runGroups.id, group!.id));
    await tx
      .insert(outbox)
      .values([
        {
          runId: run.id,
          groupId: group!.id,
          effect: "agent",
          idemKey: `agent:${group!.id}:${n}`,
          payloadJson: { kind: "agent", runId: run.id, attempt: n },
        },
        // The run's check run is drawn again, so its buttons follow the counter.
        {
          runId: run.id,
          groupId: group!.id,
          effect: "check_run",
          idemKey: `check:${run.id}:agent:${n}`,
          payloadJson: { kind: "check_run", runId: run.id, status: "completed" },
        },
      ])
      .onConflictDoNothing({ target: outbox.idemKey });
    return { sent: n };
  });
}

/**
 * The fix request for a failed run (§26.3), signed with the fixer secret: what each failed
 * criterion expected, what the judges saw, the readings, the trigger steps, and the files the PR
 * changed that coverage maps to them.
 */
export async function fixerPayload(
  db: Db,
  runId: string,
  reportBaseUrl: string,
  secret: string,
): Promise<FixerPayload> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`run ${runId} doesn't exist`);
  const [version] =
    run.intentVersionId === null
      ? []
      : await db.select().from(intentVersions).where(eq(intentVersions.id, run.intentVersionId));
  const intent = CriterionSet.safeParse(version?.intentJson);
  const results = await db
    .select()
    .from(criteriaResults)
    .where(and(eq(criteriaResults.runId, runId), eq(criteriaResults.verdict, "fail")));
  if (results.length === 0) throw new Error(`run ${runId} has no failed criterion to fix`);

  const criteria = results.map((result) => {
    const criterion = intent.success
      ? intent.data.criteria.find((c) => c.id === result.criterionId)
      : undefined;
    const evidence = (result.evidenceJson ?? {}) as StoredEvidence;
    const pr = ((result.lanesJson ?? []) as LaneResult[]).find((l) => l.side === "pr");
    return {
      id: result.criterionId,
      text: criterion?.text ?? "",
      expected: criterion?.expected ?? "",
      observed: evidence.observed ?? "",
      readings: pr ? readingParts(pr) : [],
      steps: pr ? pr.stepLog.filter((s) => s.trigger).map((s) => describeStep(s.step)) : [],
    };
  });
  const failed = new Set(criteria.map((c) => c.id));
  const coverage = CoverageMap.safeParse(run.coverageJson);
  const files = coverage.success
    ? [
        ...new Set(
          coverage.data.items.filter((i) => failed.has(i.criterionId)).flatMap((i) => i.files),
        ),
      ]
    : [];
  return buildFixerPayload(secret, {
    runId,
    headSha: run.headSha,
    criteria,
    files,
    report: `${reportBaseUrl.replace(/\/$/, "")}/r/${runId}`,
  });
}
