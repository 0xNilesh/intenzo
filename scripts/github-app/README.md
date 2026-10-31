# GitHub App tooling (ROADMAP T0.4, reused by T2.1)

Registers a GitHub App from the ARCHITECTURE §12 manifest, acts as it on a sandbox repo, and saves
the webhooks GitHub sent it as test fixtures. T0.4 used these to answer the platform questions
(DECISIONS 2026-10-30 · Platform checks). T2.1 can register the real App the same way.

## Commands

```bash
pnpm github-app:create [--name=intenzo-t04-xxxxxx] [--hook=https://example.com/intenzo-webhook]
pnpm github-app:sandbox whoami    <owner/repo>
pnpm github-app:sandbox comment   <owner/repo> <issue-or-pr> <body…>
pnpm github-app:sandbox check-run <owner/repo> <head-sha> [--in-progress]
pnpm github-app:sandbox closing   <owner/repo> <pr>
pnpm github-app:fixtures [--list | --all]
```

- **`github-app:create`** runs GitHub's manifest flow:
  1. It prints a `127.0.0.1` link. Open it in a browser signed in to GitHub and press the button.
  2. Confirm on github.com. GitHub sends the browser back with a one-hour code.
  3. The code is exchanged for the App's id, slug, private key and webhook secret.

  These are written to `.env.github-app` and `.env.github-app.pem` in the repo root (gitignored by `.env.*`, mode 600) and never printed. Then install the App on the repos you want, and only those.

- **`github-app:sandbox`** mints a short-lived installation token for the repo and, as the App:
  - `whoami` prints the bot login and the installation's permissions and events
  - `comment` posts a comment
  - `check-run` creates the `Intenzo` check run with the §26.2 requested actions (completed, or in progress)
  - `closing` runs the §17.2 `closingIssuesReferences` query
- **`github-app:fixtures`** reads the App's webhook deliveries back from GitHub and writes the first delivery of each kind to `packages/core/fixtures/github/`, with emails and token-shaped strings redacted. This works whether or not the webhook URL answered: GitHub keeps each payload for a few days. `--list` only prints them; `--all` writes every delivery.

No command calls a paid API. Everything goes to `api.github.com` with the App's own credentials.

## The real App (T2.1)

The real Intenzo App is registered the same way, into its own credentials file, so the T0.4 App's
files stay as they are. `GITHUB_APP_ENV` picks the file for every command (only gitignored
`.env.<name>` files are accepted):

```bash
GITHUB_APP_ENV=.env.intenzo-app pnpm github-app:create --name=intenzo --hook=https://<cloud>/api/github/webhook
GITHUB_APP_ENV=.env.intenzo-app pnpm github-app:sandbox whoami sumithprabhu/demo-shop
```

Its id and webhook secret then go into the Cloud's environment (see `apps/cloud/README.md`).

## The sandbox

`sandbox/` holds the files T0.4 pushed to `sumithprabhu/intenzo-t04-sandbox`:

- `index.html`: something for Vercel to deploy.
- `comment-trigger.yml`: logs who posted each comment, and has a job that uses the exact §26.4 muse-fixer guard. Replace `__APP_SLUG__` with the App's slug before pushing it.
- `vercel-dispatch.yml`: logs any `repository_dispatch` Vercel sends, with its `client_payload`.

To reproduce T0.4:

1. Create a private repo and push these files.
2. Register the App and install it on that repo only.
3. Import the repo into Vercel, and turn on **Settings → Git → "deployment_status Events"**. It was off on a new project.
4. Open a PR and push to it. Then run `comment`, `check-run` and `closing`, press a button in the PR's Checks tab, and export the fixtures.
