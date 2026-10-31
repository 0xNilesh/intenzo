// drainOutbox() (§16.4): claim one due row at a time with FOR UPDATE SKIP LOCKED and a lease, run
// its effect, and record the result. Any number of drainers may run at once (each webhook drains
// after its event, and the sweeper will too): SKIP LOCKED hands each row to exactly one of them,
// and a row whose drainer died is claimed again once its lease has run out.
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import type { Db } from "../db/db.ts";
import { outbox } from "../db/schema.ts";

export type OutboxRow = typeof outbox.$inferSelect;

export interface EffectExecutor {
  /** Performs the effect and returns the id it produced (a check run's, a comment's), if any. */
  run: (row: OutboxRow) => Promise<string | null>;
  /**
   * §16.4: the row is marked done before it runs, so a crash loses the effect rather than repeating
   * it. For the agent mention, where a repeat would start a second paid fixer run.
   */
  atMostOnce?: boolean;
}

export interface DrainOptions {
  db: Db;
  /** By effect. A row whose effect has no executor yet stays pending (spawn and cancel: T2.5). */
  executors: Readonly<Partial<Record<string, EffectExecutor>>>;
  now: () => Date;
  /** One line per failure: the row's key and the error, never a payload. */
  log: (line: string) => void;
}

/** How long a claimed row is a drainer's own before another may claim it again. */
export const LEASE_MS = 60_000;
/** A row that fails this many times is marked failed and left alone. */
export const MAX_ATTEMPTS = 5;
/** The wait after a failed attempt: 10 s, 20 s, 40 s, 80 s. */
export const backoffMs = (attempts: number) => 5_000 * 2 ** attempts;
/** Rows one drain call executes at most, so one function invocation stays short. */
const MAX_ROWS = 50;

export async function drainOutbox(
  options: DrainOptions,
): Promise<{ done: number; failed: number }> {
  const { db, executors, now, log } = options;
  const kinds = Object.keys(executors).filter((kind) => executors[kind]);
  const atMostOnce = kinds.filter((kind) => executors[kind]!.atMostOnce);
  const result = { done: 0, failed: 0 };
  for (let i = 0; i < MAX_ROWS; i++) {
    const row = await claimNext(db, kinds, atMostOnce, now());
    if (!row) break;
    const executor = executors[row.effect]!;
    try {
      const externalId = await executor.run(row);
      await db
        .update(outbox)
        .set({ status: "done", externalId, leaseUntil: null, lastError: null })
        .where(and(eq(outbox.id, row.id), eq(outbox.attempts, row.attempts)));
      result.done += 1;
    } catch (err) {
      result.failed += 1;
      const lastError = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
      if (executor.atMostOnce) {
        log(`outbox ${row.idemKey}: failed, and isn't retried (at most once): ${lastError}`);
        await db.update(outbox).set({ lastError }).where(eq(outbox.id, row.id));
        continue;
      }
      const gaveUp = row.attempts >= MAX_ATTEMPTS;
      log(
        `outbox ${row.idemKey}: attempt ${row.attempts} failed${gaveUp ? ", giving up" : ""}: ${lastError}`,
      );
      await db
        .update(outbox)
        .set(
          gaveUp
            ? { status: "failed", leaseUntil: null, lastError }
            : {
                status: "pending",
                leaseUntil: new Date(now().getTime() + backoffMs(row.attempts)),
                lastError,
              },
        )
        .where(and(eq(outbox.id, row.id), eq(outbox.attempts, row.attempts)));
    }
  }
  return result;
}

/**
 * Claims the oldest due row of these effects: pending and past its backoff, or in flight past its
 * lease (its drainer died). An at-most-once row is marked done as it's claimed.
 */
export async function claimNext(
  db: Db,
  kinds: readonly string[],
  atMostOnce: readonly string[],
  now: Date,
): Promise<OutboxRow | null> {
  if (kinds.length === 0) return null;
  const due = db
    .select({ id: outbox.id })
    .from(outbox)
    .where(
      and(
        inArray(outbox.effect, [...kinds]),
        or(
          and(
            eq(outbox.status, "pending"),
            or(isNull(outbox.leaseUntil), lte(outbox.leaseUntil, now)),
          ),
          and(eq(outbox.status, "in_flight"), lt(outbox.leaseUntil, now)),
        ),
      ),
    )
    .orderBy(asc(outbox.id))
    .limit(1)
    .for("update", { skipLocked: true });
  const status =
    atMostOnce.length > 0
      ? sql<
          OutboxRow["status"]
        >`case when ${inArray(outbox.effect, [...atMostOnce])} then 'done' else 'in_flight' end`
      : "in_flight";
  const [row] = await db
    .update(outbox)
    .set({
      status,
      leaseUntil: new Date(now.getTime() + LEASE_MS),
      attempts: sql`${outbox.attempts} + 1`,
    })
    // `= (subquery)`, not `in`: Postgres's documented queue pattern, which claims exactly one row.
    .where(sql`${outbox.id} = (${due})`)
    .returning();
  return row ?? null;
}
