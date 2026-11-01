// The outbox (§16.4): each effect of a decision becomes a row in the same transaction as the run
// change, with an idempotency key, so a crash can't lose an effect and nothing is done twice. The
// drainer (drain.ts) executes the rows afterwards.
import { and, count, eq } from "drizzle-orm";

import type { Db } from "../db/db.ts";
import { outbox } from "../db/schema.ts";
import type { Effect } from "../runs/transition.ts";

export type NewOutboxRow = typeof outbox.$inferInsert;

/**
 * §16.4's idempotency keys. A run passes each check-run status at most once, so the status keys
 * its row; comments are numbered per group.
 */
export function outboxRows(groupId: number, effects: readonly Effect[], commentSeq: number) {
  return effects.map((effect): NewOutboxRow => {
    switch (effect.kind) {
      case "check_run":
        return row(effect, groupId, effect.runId, `check:${effect.runId}:${effect.status}`);
      case "comment":
        return row(effect, groupId, null, `comment:${groupId}:${commentSeq}`);
      case "spawn_job":
        return row(effect, groupId, effect.runId, `spawn:${effect.runId}:verify`);
      case "cancel_job":
        return row(effect, groupId, effect.runId, `cancel:${effect.runId}`);
      case "label":
        return row(effect, groupId, null, `label:${groupId}:${effect.name}`);
    }
  });
}

function row(effect: Effect, groupId: number, runId: string | null, idemKey: string): NewOutboxRow {
  return { runId, groupId, effect: effect.kind, idemKey, payloadJson: effect };
}

/**
 * Writes a decision's effects. Call it inside advance()'s transaction, which holds the group's row
 * lock, so the comment numbering can't race. A key that's already there is skipped.
 */
export async function enqueueEffects(tx: Db, groupId: number, effects: readonly Effect[]) {
  if (effects.length === 0) return;
  const [comments] = await tx
    .select({ n: count() })
    .from(outbox)
    .where(and(eq(outbox.groupId, groupId), eq(outbox.effect, "comment")));
  const rows = outboxRows(groupId, effects, (comments?.n ?? 0) + 1);
  await tx.insert(outbox).values(rows).onConflictDoNothing({ target: outbox.idemKey });
}
