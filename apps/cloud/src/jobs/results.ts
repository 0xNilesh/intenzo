// What a job learns, stored where the report reads it (§9, §11): the criteria (intent_ready), a
// verdict per criterion (criterion_verdict) and its evidence (criterion_evidence). Each changes
// the comment, which is re-rendered from the database (§26.1: verdicts stream in).
import type { WorkerEvent } from "@intenzo/core";
import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../db/db.ts";
import { criteriaResults, intentVersions, runGroups, runs } from "../db/schema.ts";
import { enqueueEffects } from "../outbox/rows.ts";

type RunRow = typeof runs.$inferSelect;

/** The events that add to the report. */
export const RESULT_EVENTS: ReadonlySet<WorkerEvent["kind"]> = new Set([
  "intent_ready",
  "criterion_verdict",
  "criterion_evidence",
]);

const merge = (column: typeof criteriaResults.evidenceJson, value: object) =>
  sql`coalesce(${column}, '{}'::jsonb) || ${JSON.stringify(value)}::jsonb`;

export async function storeResult(db: Db, run: RunRow, event: WorkerEvent): Promise<void> {
  switch (event.kind) {
    case "intent_ready": {
      // Reused while the ticket doesn't change (§11: unique per group and ticket hash).
      const [intent] = await db
        .insert(intentVersions)
        .values({
          runGroupId: run.runGroupId,
          ticketHash: event.intent.ticketHash,
          intentJson: event.intent,
        })
        .onConflictDoUpdate({
          target: [intentVersions.runGroupId, intentVersions.ticketHash],
          set: { intentJson: sql`excluded.intent_json` },
        })
        .returning({ id: intentVersions.id });
      await db
        .update(runs)
        .set({ intentVersionId: intent!.id, coverageJson: event.coverage })
        .where(eq(runs.id, run.id));
      return;
    }
    case "criterion_verdict": {
      const { verdict, lanes } = event;
      const evidence = { window: verdict.evidenceWindow, observed: verdict.observed };
      await db
        .insert(criteriaResults)
        .values({
          runId: run.id,
          criterionId: verdict.criterionId,
          verdict: verdict.verdict,
          reasonCode: verdict.reasonCode,
          judgesJson: verdict.judges,
          lanesJson: lanes,
          evidenceJson: evidence,
        })
        .onConflictDoUpdate({
          target: [criteriaResults.runId, criteriaResults.criterionId],
          set: {
            verdict: sql`excluded.verdict`,
            reasonCode: sql`excluded.reason_code`,
            judgesJson: sql`excluded.judges_json`,
            lanesJson: sql`excluded.lanes_json`,
            evidenceJson: merge(criteriaResults.evidenceJson, evidence),
          },
        });
      return;
    }
    case "criterion_evidence":
      // Evidence follows its verdict (§15), so the row is there to add to.
      await db
        .update(criteriaResults)
        .set({
          evidenceJson: merge(criteriaResults.evidenceJson, { gif: event.gif, still: event.still }),
        })
        .where(
          and(
            eq(criteriaResults.runId, run.id),
            eq(criteriaResults.criterionId, event.criterionId),
          ),
        );
      return;
    default:
      return;
  }
}

/**
 * Queues a comment re-render for the group, under its row lock like advance(), so the comment's
 * sequence numbers can't race (§16.4).
 */
export async function requestComment(db: Db, groupId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .select({ id: runGroups.id })
      .from(runGroups)
      .where(eq(runGroups.id, groupId))
      .for("update");
    await enqueueEffects(tx, groupId, [{ kind: "comment", groupId }]);
  });
}
