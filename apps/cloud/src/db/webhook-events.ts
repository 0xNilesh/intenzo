// Reads and writes of webhook_events (§11).
import { eq, sql } from "drizzle-orm";

import type { Db } from "./db.ts";
import { webhookEvents } from "./schema.ts";

/** Long enough for a stack's first lines; an error column isn't a log. */
const MAX_ERROR_LENGTH = 2000;

export interface NewWebhookEvent {
  deliveryId: string;
  event: string;
  action: string | null;
  /** The request body as text. It's cast to jsonb in SQL, never through JSON.parse. */
  body: string;
  receivedAt: Date;
}

/** Stores a delivery and returns its row id, or null when this delivery id is already stored. */
export async function recordWebhookEvent(db: Db, event: NewWebhookEvent): Promise<number | null> {
  const rows = await db
    .insert(webhookEvents)
    .values({
      deliveryId: event.deliveryId,
      event: event.event,
      action: event.action,
      payloadJson: sql`${event.body}::jsonb`,
      receivedAt: event.receivedAt,
    })
    .onConflictDoNothing({ target: webhookEvents.deliveryId })
    .returning({ id: webhookEvents.id });
  return rows[0]?.id ?? null;
}

export async function markProcessed(db: Db, id: number, at: Date): Promise<void> {
  await db
    .update(webhookEvents)
    .set({ processedAt: at, error: null })
    .where(eq(webhookEvents.id, id));
}

export async function markFailed(db: Db, id: number, error: string): Promise<void> {
  await db
    .update(webhookEvents)
    .set({ error: error.slice(0, MAX_ERROR_LENGTH) })
    .where(eq(webhookEvents.id, id));
}
