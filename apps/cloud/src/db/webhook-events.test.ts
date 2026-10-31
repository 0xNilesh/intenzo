import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { webhookEvents } from "./schema.ts";
import { testDb } from "./test-db.ts";
import { markFailed, markProcessed, recordWebhookEvent } from "./webhook-events.ts";

const AT = new Date("2026-10-31T09:00:00.000Z");

const delivery = (overrides: Partial<Parameters<typeof recordWebhookEvent>[1]> = {}) => ({
  deliveryId: "242ae330-d462-11f1-9155-4b63fde5d042",
  event: "pull_request",
  action: "opened",
  body: '{"action":"opened","number":2}',
  receivedAt: AT,
  ...overrides,
});

let t: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.db.execute(sql`truncate ${webhookEvents}`);
});

describe("recordWebhookEvent", () => {
  it("stores a delivery once: a redelivery of the same id returns null", async () => {
    const id = await recordWebhookEvent(t.db, delivery());
    expect(id).toEqual(expect.any(Number));
    expect(await recordWebhookEvent(t.db, delivery({ action: "edited" }))).toBeNull();

    const rows = await t.db.select().from(webhookEvents);
    expect(rows).toEqual([
      {
        id,
        deliveryId: "242ae330-d462-11f1-9155-4b63fde5d042",
        event: "pull_request",
        action: "opened",
        payloadJson: { action: "opened", number: 2 },
        receivedAt: AT,
        processedAt: null,
        error: null,
      },
    ]);
  });

  it("keeps every digit of a 64-bit id, which JSON.parse would round", async () => {
    const big = "9007199254740993"; // 2^53 + 1
    expect(String(JSON.parse(`{"id":${big}}`).id)).not.toBe(big);

    await recordWebhookEvent(t.db, delivery({ body: `{"deployment":{"id":${big}}}` }));
    const [row] = await t.db
      .select({ id: sql<string>`${webhookEvents.payloadJson} -> 'deployment' ->> 'id'` })
      .from(webhookEvents);
    expect(row?.id).toBe(big);
  });

  it("stores events without an action (ping, installation_repositories…)", async () => {
    await recordWebhookEvent(t.db, delivery({ event: "ping", action: null, body: "{}" }));
    const [row] = await t.db.select().from(webhookEvents);
    expect(row).toMatchObject({ event: "ping", action: null, payloadJson: {} });
  });
});

describe("markProcessed / markFailed", () => {
  it("records a failure, then clears it once the event is processed", async () => {
    const id = (await recordWebhookEvent(t.db, delivery()))!;

    await markFailed(t.db, id, `boom ${"x".repeat(5000)}`);
    let [row] = await t.db.select().from(webhookEvents);
    expect(row?.processedAt).toBeNull();
    expect(row?.error).toMatch(/^boom x+$/);
    expect(row?.error).toHaveLength(2000);

    const later = new Date(AT.getTime() + 1500);
    await markProcessed(t.db, id, later);
    [row] = await t.db.select().from(webhookEvents);
    expect(row).toMatchObject({ processedAt: later, error: null });
  });
});
