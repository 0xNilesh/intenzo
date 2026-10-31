# @intenzo/cloud

Intenzo Cloud (ARCHITECTURE §2, §3): the Next.js app on Vercel that receives GitHub's webhooks,
keeps run state in Postgres and drives runs. It's the only code with GitHub credentials.

## What it does so far (T2.3)

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

What happens after an event is stored (`src/github/handlers.ts`, ARCHITECTURE §16.2, §17):

| Event                                                                  | What the Cloud does                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pull_request` `opened`, `reopened`, `ready_for_review`, `synchronize` | Reads `.intenzo.yml` from the default branch, looks the head's preview up (the `deployments` table, then GitHub once), and advances the PR's run group: a new run, the old one superseded              |
| `deployment_status`                                                    | Stores the deployment. A preview's success or failure then advances the open PRs whose head is that commit. Production is never used                                                                   |
| a run starts verifying                                                 | Its baseline (§17.3): the preview of the PR's merge base with its base branch, or of the nearest commit before it, stored on the run and logged: `baseline main@b6b60c7 (the merge base) at https://…` |

Other events are only stored and marked processed. The decisions' effects (check runs, the
comment, jobs) are logged until the outbox runs them (T2.4).

## Environment

| Variable                    | What                                                     | Where it comes from                                                                     |
| --------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | Neon's pooled connection string                          | the Neon integration from the Vercel Marketplace sets it                                |
| `DATABASE_URL_UNPOOLED`     | Neon's direct connection, used by `pnpm db:migrate`      | the same integration                                                                    |
| `GITHUB_APP_ID`             | the App's id                                             | `.env.intenzo-app`, written when the App is registered (`scripts/github-app/README.md`) |
| `GITHUB_APP_WEBHOOK_SECRET` | the App's webhook secret                                 | the same file                                                                           |
| `GITHUB_APP_PRIVATE_KEY`    | the App's private key (PEM), to mint installation tokens | `.env.intenzo-app.pem`                                                                  |

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
migrations as production (`drizzle/`), so they need no Docker and no network. GitHub is mocked with
[msw](https://mswjs.io) (`src/github/fake-github.ts`), which answers `fetch` in-process and fails any
request a test didn't expect.

## Deploying

Intenzo Cloud is the Vercel project `intenzo-cloud` (account sumithprabhu), live at
https://intenzo-cloud.vercel.app. It isn't connected to Git (DECISIONS 2026-10-31), so deploys
run from a checkout:

```bash
vercel link --yes --project intenzo-cloud   # once, from the repo root
vercel deploy --prod                       # from the repo root, so the pnpm workspace is uploaded
```

- The project's Root Directory is `apps/cloud`; `vercel.json` here pins the Next.js preset.
- `/.vercelignore` keeps every `.env` file, private key and local recording out of the upload.
- Neon's variables come from the Marketplace integration. `GITHUB_APP_ID` and
  `GITHUB_APP_WEBHOOK_SECRET` were added with `vercel env add <name> production` from
  `.env.intenzo-app`, the secret as `--sensitive`. The private key went in from its file, never
  printed: `vercel env add GITHUB_APP_PRIVATE_KEY production --sensitive < .env.intenzo-app.pem`.
  A changed variable needs a new deploy.
- Schema changes: `vercel env pull .env.local --environment=production` in this folder (once),
  then `pnpm db:migrate`.

## Costs

Nothing paid: Vercel's Hobby plan and Neon's free plan. No model calls. GitHub's API is free; each PR
event costs a few calls of the installation's 5,000 an hour (the config, the head's preview, and the
baseline's compare, deployments and commits).
