# @intenzo/cloud

Intenzo Cloud (ARCHITECTURE §2, §3): the Next.js app on Vercel that receives GitHub's webhooks and
keeps run state in Postgres. From T2.2 on it also drives runs and reports back to GitHub. It's the
only code with GitHub credentials.

## What it does so far (T2.1)

| Route                      | What it does                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/github/webhook` | Checks `X-Hub-Signature-256`, stores each delivery once in `webhook_events`, answers, then dispatches the event after the response (`after()`) |
| `GET /`                    | A placeholder page                                                                                                                             |

`POST /api/github/webhook` answers:

| Status          | When                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| 202 `accepted`  | a new delivery of an event Intenzo acts on: stored, then dispatched                                  |
| 200 `duplicate` | a delivery id that's already stored (GitHub redelivers): nothing else happens                        |
| 200 `ignored`   | an event outside §12 (`ping`, `check_suite`…) or another app's check run (T0.4): not stored          |
| 400             | no `X-GitHub-Event` or `X-GitHub-Delivery`, or a body that isn't a UTF-8 JSON object                 |
| 401             | a missing or wrong signature                                                                         |
| 500             | the env vars aren't set (the error names them, never their values), or the database can't be reached |

Event handlers arrive with the tasks that need them (T2.2 `pull_request`, T2.3 `deployment_status`).
Until then an accepted event is only stored and marked processed.

## Environment

| Variable                    | What                                                | Where it comes from                                                                     |
| --------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | Neon's pooled connection string                     | the Neon integration from the Vercel Marketplace sets it                                |
| `DATABASE_URL_UNPOOLED`     | Neon's direct connection, used by `pnpm db:migrate` | the same integration                                                                    |
| `GITHUB_APP_ID`             | the App's id                                        | `.env.intenzo-app`, written when the App is registered (`scripts/github-app/README.md`) |
| `GITHUB_APP_WEBHOOK_SECRET` | the App's webhook secret                            | the same file                                                                           |

Locally they go in `apps/cloud/.env.local` (gitignored), for example with `vercel env pull .env.local`
in this folder.

## Commands

```bash
pnpm --filter @intenzo/cloud dev     # next dev
pnpm --filter @intenzo/cloud build   # next build
pnpm --filter @intenzo/cloud test    # unit tests, the database ones included
pnpm db:generate                     # write a migration for a change to src/db/schema.ts
pnpm db:migrate                      # apply the migrations to DATABASE_URL_UNPOOLED (else DATABASE_URL)
```

The database tests run a real Postgres in-process with [PGlite](https://pglite.dev) and apply the same
migrations as production (`drizzle/`), so they need no Docker and no network.

## Costs

Nothing paid: Vercel's Hobby plan and Neon's free plan. No model calls.
