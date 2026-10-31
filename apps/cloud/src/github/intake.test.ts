import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { webhookEvents } from "../db/schema.ts";
import { testDb } from "../db/test-db.ts";
import { recordWebhookEvent } from "../db/webhook-events.ts";
import { type AcceptedEvent, handleWebhook } from "./intake.ts";
import { signWebhook } from "./signature.ts";

// Real deliveries captured in T0.4 (packages/core/fixtures/github/README.md).
const FIXTURES = new URL("../../../../packages/core/fixtures/github/", import.meta.url);
const SECRET = "test-webhook-secret";
/** intenzo-demo, the T0.4 App whose own check runs are in the fixtures. */
const APP_ID = 5541686;
const AT = new Date("2026-10-31T09:00:00.000Z");

interface Fixture {
  event: string;
  action: string | null;
  deliveryId: string;
  payload: Record<string, unknown>;
}

const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8")) as Fixture;

function post(
  f: Fixture,
  { body = JSON.stringify(f.payload), secret = SECRET, deliveryId = f.deliveryId } = {},
  headers: Record<string, string | null> = {},
): Request {
  const all: Record<string, string | null> = {
    "content-type": "application/json",
    "x-github-event": f.event,
    "x-github-delivery": deliveryId,
    "x-hub-signature-256": signWebhook(secret, body),
    ...headers,
  };
  const present = Object.entries(all).filter((e): e is [string, string] => e[1] !== null);
  return new Request("https://cloud.test/api/github/webhook", {
    method: "POST",
    headers: present,
    body,
  });
}

let t: Awaited<ReturnType<typeof testDb>>;
let deferred: (() => Promise<void>)[];
let dispatched: AcceptedEvent[];

const handle = (request: Request) =>
  handleWebhook(request, {
    secret: SECRET,
    appId: APP_ID,
    record: (event) => recordWebhookEvent(t.db, event),
    dispatch: async (event) => {
      dispatched.push(event);
    },
    defer: (work) => deferred.push(work),
    now: () => AT,
  });

/** Runs what the route would hand to after(), once the response has gone. */
const afterResponse = () => Promise.all(deferred.splice(0).map((work) => work()));
const rows = () => t.db.select().from(webhookEvents);

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.db.execute(sql`truncate ${webhookEvents}`);
  deferred = [];
  dispatched = [];
});

describe("handleWebhook", () => {
  it("accepts a signed delivery, stores it, and dispatches it only after the response", async () => {
    const opened = fixture("pull_request.opened");
    const res = await handle(post(opened));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "accepted" });
    expect(dispatched).toEqual([]);
    expect(await rows()).toEqual([
      expect.objectContaining({
        deliveryId: opened.deliveryId,
        event: "pull_request",
        action: "opened",
        receivedAt: AT,
        processedAt: null,
      }),
    ]);

    await afterResponse();
    const [row] = await rows();
    expect(dispatched).toEqual([
      {
        id: row!.id,
        deliveryId: opened.deliveryId,
        event: "pull_request",
        action: "opened",
        payload: expect.objectContaining({ number: 2 }),
      },
    ]);
  });

  it("answers a redelivery of the same delivery id without storing or dispatching it again", async () => {
    const opened = fixture("pull_request.opened");
    expect((await handle(post(opened))).status).toBe(202);

    const again = await handle(post(opened));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "duplicate" });

    await afterResponse();
    expect(await rows()).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
  });

  it.each([
    ["signed with another secret", { secret: "not-the-secret" }, {}],
    ["with no signature", {}, { "x-hub-signature-256": null }],
    ["whose body changed after signing", {}, { "x-hub-signature-256": signWebhook(SECRET, "{}") }],
  ])("refuses a delivery %s with 401, storing nothing", async (_name, options, headers) => {
    const res = await handle(post(fixture("pull_request.opened"), options, headers));

    expect(res.status).toBe(401);
    await afterResponse();
    expect(await rows()).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it.each([
    "installation.created",
    "issues.opened",
    "pull_request.synchronize",
    "deployment_status.success.preview",
    "deployment_status.success.production",
    "issue_comment.created.user",
    "issue_comment.created.bot-vercel",
    "check_run.created.intenzo-demo",
    "check_run.requested_action.approve.completed",
  ])("accepts %s", async (name) => {
    const res = await handle(post(fixture(name)));
    expect(res.status).toBe(202);
  });

  it.each([
    ["check_run.created.vercel", "another app's check run"],
    ["check_run.completed.github-actions", "another app's check run"],
    ["check_suite.requested", "not an event Intenzo acts on: check_suite"],
    ["ping.none", "not an event Intenzo acts on: ping"],
  ])("drops %s (%s) with 200, storing nothing", async (name, reason) => {
    const res = await handle(post(fixture(name)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored", reason });
    await afterResponse();
    expect(await rows()).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it.each(["x-github-event", "x-github-delivery"])(
    "answers 400 to a signed delivery without %s",
    async (header) => {
      const res = await handle(post(fixture("pull_request.opened"), {}, { [header]: null }));
      expect(res.status).toBe(400);
      expect(await rows()).toEqual([]);
    },
  );

  it.each([
    ["not JSON", "not json"],
    ["a JSON array", "[1, 2]"],
    ["invalid UTF-8", "ÿ"],
  ])("answers 400 to a signed body that is %s", async (_name, body) => {
    const opened = fixture("pull_request.opened");
    const bytes = body === "ÿ" ? new Uint8Array([0x7b, 0xff, 0x7d]) : body;
    const request = new Request("https://cloud.test/api/github/webhook", {
      method: "POST",
      headers: {
        "x-github-event": opened.event,
        "x-github-delivery": opened.deliveryId,
        "x-hub-signature-256": signWebhook(SECRET, bytes),
      },
      body: bytes,
    });

    expect((await handle(request)).status).toBe(400);
    expect(await rows()).toEqual([]);
  });
});
