// POST /api/github/webhook (§12). The logic is handleWebhook() in src/github/intake.ts; this binds
// it to the environment, the database and Next's after(), which keeps the function alive until
// the dispatch it defers has finished (nextjs.org/docs/app/api-reference/functions/after).
import { after } from "next/server";

import { database } from "../../../../db/client.ts";
import { markFailed, markProcessed, recordWebhookEvent } from "../../../../db/webhook-events.ts";
import { cloudEnv } from "../../../../env.ts";
import { createDispatcher, type EventHandler } from "../../../../github/dispatch.ts";
import { handleWebhook } from "../../../../github/intake.ts";

/** Handlers per event type. None yet: T2.2 adds pull_request, T2.3 deployment_status. */
const HANDLERS: Partial<Record<string, EventHandler>> = {};

export async function POST(request: Request): Promise<Response> {
  const env = cloudEnv();
  const db = database(env.DATABASE_URL);
  const now = () => new Date();
  return handleWebhook(request, {
    secret: env.GITHUB_APP_WEBHOOK_SECRET,
    appId: env.GITHUB_APP_ID,
    record: (event) => recordWebhookEvent(db, event),
    dispatch: createDispatcher({
      handlers: HANDLERS,
      markProcessed: (id, at) => markProcessed(db, id, at),
      markFailed: (id, error) => markFailed(db, id, error),
      now,
      log: (line) => console.error(line),
    }),
    defer: (work) => after(work),
    now,
  });
}
