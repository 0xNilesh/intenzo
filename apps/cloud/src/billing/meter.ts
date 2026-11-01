// The billing meter (ARCHITECTURE §16.3, T5.7): a run group is billed once, when a run first
// finishes with at least one criterion judged pass or fail; every 5 judged runs in the group (the
// first included) make one unit. Runs that judged nothing (setup_failed, precondition_unmet,
// not_verifiable, no_isolation, infra_error: all inconclusive) are never billed. Hackathon:
// metered and displayed only.
import { and, count, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "../db/db.ts";
import { criteriaResults, runGroups } from "../db/schema.ts";
import type { Run } from "../runs/transition.ts";

/** §16.3: judged runs per unit. */
export const RUNS_PER_UNIT = 5;

/** Units for this many judged runs: 1–5 → 1, 6–10 → 2, none → 0. */
export function billingUnits(judgedRuns: number): number {
  return Math.ceil(Math.max(0, judgedRuns) / RUNS_PER_UNIT);
}

/** Outcomes a run can finish with that may bill: not superseded, not cancelled. */
const BILLABLE = new Set(["pass", "fail", "inconclusive", "error"]);

/**
 * Meters the runs a decision just finished. Call it inside advance()'s transaction, which holds the
 * group's row lock, so the count and billed_at change with the run (§16.3).
 */
export async function meterFinished(
  tx: Db,
  groupId: number,
  finished: readonly Run[],
  now: Date,
): Promise<number> {
  let judged = 0;
  for (const run of finished) {
    if (run.state !== "done" || !run.outcome || !BILLABLE.has(run.outcome)) continue;
    const [verdicts] = await tx
      .select({ n: count() })
      .from(criteriaResults)
      .where(
        and(eq(criteriaResults.runId, run.id), inArray(criteriaResults.verdict, ["pass", "fail"])),
      );
    if ((verdicts?.n ?? 0) > 0) judged++;
  }
  if (judged > 0) {
    await tx
      .update(runGroups)
      .set({
        judgedRuns: sql`${runGroups.judgedRuns} + ${judged}`,
        billedAt: sql`coalesce(${runGroups.billedAt}, ${now.toISOString()}::timestamptz)`,
      })
      .where(eq(runGroups.id, groupId));
  }
  return judged;
}
