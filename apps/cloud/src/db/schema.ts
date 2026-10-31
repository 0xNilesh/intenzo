// The Cloud's Postgres tables (§11), in Drizzle. `pnpm db:generate` writes each change as a SQL
// migration in apps/cloud/drizzle/, and `pnpm db:migrate` applies them.
import { bigint, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Each webhook delivery Intenzo acts on, stored once (§11, §17). GitHub redelivers after a timeout
 * or when someone presses "Redeliver", so `delivery_id` (the X-GitHub-Delivery GUID) is unique and
 * a redelivery is answered without being dispatched again.
 */
export const webhookEvents = pgTable("webhook_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  deliveryId: text("delivery_id").notNull().unique(),
  event: text("event").notNull(),
  action: text("action"),
  /** The body as GitHub sent it. Postgres parses it, so 64-bit ids keep every digit (T0.4). */
  payloadJson: jsonb("payload_json").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  /** Set when dispatch finished. Null with `error` set: dispatch failed. */
  processedAt: timestamp("processed_at", { withTimezone: true }),
  error: text("error"),
});
