// POST /api/github/webhook (§12). The logic is handleWebhook() in src/github/intake.ts; this binds
// it to the environment, the database, GitHub and Next's after(), which keeps the function alive
// until the dispatch it defers has finished (nextjs.org/docs/app/api-reference/functions/after).
import { randomUUID } from "node:crypto";

import { after } from "next/server";

import { database } from "../../../../db/client.ts";
import { markFailed, markProcessed, recordWebhookEvent } from "../../../../db/webhook-events.ts";
import { cloudEnv } from "../../../../env.ts";
import { githubClient } from "../../../../github/api.ts";
import { installationTokens } from "../../../../github/app-auth.ts";
import { createDispatcher } from "../../../../github/dispatch.ts";
import { eventHandlers } from "../../../../github/handlers.ts";
import { handleWebhook } from "../../../../github/intake.ts";

/** Installation tokens live for an hour, so one token cache per function instance. */
let tokens: { key: string; mint: (installationId: number) => Promise<string> } | undefined;

export async function POST(request: Request): Promise<Response> {
  const env = cloudEnv();
  const db = database(env.DATABASE_URL);
  const now = () => new Date();
  const app = { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY };
  const key = `${app.appId}\n${app.privateKey}`;
  if (tokens?.key !== key) tokens = { key, mint: installationTokens(app, now) };
  const { mint } = tokens;

  return handleWebhook(request, {
    secret: env.GITHUB_APP_WEBHOOK_SECRET,
    appId: env.GITHUB_APP_ID,
    record: (event) => recordWebhookEvent(db, event),
    dispatch: createDispatcher({
      handlers: eventHandlers({
        db,
        github: (installationId) => githubClient(() => mint(installationId)),
        now,
        newRunId: randomUUID,
        log: (line) => console.log(line),
      }),
      markProcessed: (id, at) => markProcessed(db, id, at),
      markFailed: (id, error) => markFailed(db, id, error),
      now,
      log: (line) => console.error(line),
    }),
    defer: (work) => after(work),
    now,
  });
}
