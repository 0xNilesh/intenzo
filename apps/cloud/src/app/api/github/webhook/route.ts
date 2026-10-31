// POST /api/github/webhook (§12). The logic is handleWebhook() in src/github/intake.ts; this binds
// it to the Cloud (src/cloud.ts) and Next's after(), which keeps the function alive until the
// dispatch it defers has finished (nextjs.org/docs/app/api-reference/functions/after).
import { after } from "next/server";

import { cloud } from "../../../../cloud.ts";
import { markFailed, markProcessed, recordWebhookEvent } from "../../../../db/webhook-events.ts";
import { createDispatcher } from "../../../../github/dispatch.ts";
import { eventHandlers } from "../../../../github/handlers.ts";
import { handleWebhook } from "../../../../github/intake.ts";

export async function POST(request: Request): Promise<Response> {
  const { env, db, now, github, log, newRunId, drain } = cloud();
  return handleWebhook(request, {
    secret: env.GITHUB_APP_WEBHOOK_SECRET,
    appId: env.GITHUB_APP_ID,
    record: (event) => recordWebhookEvent(db, event),
    dispatch: createDispatcher({
      handlers: eventHandlers({ db, github, now, newRunId, log, drain }),
      markProcessed: (id, at) => markProcessed(db, id, at),
      markFailed: (id, error) => markFailed(db, id, error),
      now,
      log: (line) => console.error(line),
    }),
    defer: (work) => after(work),
    now,
  });
}
