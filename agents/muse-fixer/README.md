# @intenzo/muse-fixer

Intenzo's reference coding agent (ARCHITECTURE §26.4): a GitHub Action in the target repo that
fixes the criteria Intenzo found failing. Intenzo's App comments a signed fix request on the pull
request (§26.3); the workflow checks it, has **Muse Code** fix the code, typechecks, and pushes
with the **intenzo-fixer** App's token, so the repo's CI, the preview and a new Intenzo run follow.
Any other coding agent can read the same request.

## Install

```bash
pnpm --filter @intenzo/muse-fixer install-into <path to a checkout of the target repo>
```

It writes `.github/workflows/muse-fixer.yml` and `.github/muse-fixer/{fix.ts,payload.ts}`. The
payload format comes from `@intenzo/core` (`packages/core/src/fixer/payload.ts`), copied in, since
the target repo doesn't have core. The scripts run on Node 24 with no dependencies. A Next.js
repo's tsconfig must leave `.github` out (they use `.ts` imports); demo-shop's does.

The target repo needs:

| Kind     | Name                        | Value                                                                |
| -------- | --------------------------- | -------------------------------------------------------------------- |
| Variable | `INTENZO_BOT_LOGIN`         | Intenzo's App bot, `<slug>[bot]` (demo-shop: `intenzo-ai[bot]`)      |
| Variable | `INTENZO_FIXER_APP_ID`      | The intenzo-fixer App's id                                           |
| Secret   | `INTENZO_FIXER_SECRET`      | The HMAC secret the Cloud signs requests with (`.env.intenzo-cloud`) |
| Secret   | `INTENZO_FIXER_PRIVATE_KEY` | The intenzo-fixer App's private key                                  |
| Secret   | `META_API_KEY`              | For Muse Code                                                        |

The intenzo-fixer App can write contents and nothing else, and gets no webhooks. Register it with
`GITHUB_APP_ENV=.env.intenzo-fixer pnpm github-app:create --fixer`, then install it on the target
repo only.

## What a run does

1. **Check** (`fix.ts check`), cheapest first, each refusal logged and nothing changed: the
   comment is from Intenzo's App (also the workflow's `if`), it holds a request, the signature
   matches (HMAC over the whole request), and the pull request is open, from the same repo (forks
   are refused: the job runs the PR's code) and still at the commit Intenzo found failing.
2. Check out that commit; `pnpm install --ignore-scripts --frozen-lockfile`.
3. **Fix** (`fix.ts fix`): `muse exec --json --max-model-steps 20 --disable-approval` with the
   failure as untrusted data. A fix that changes nothing, or touches `.github/`, `package.json`
   or a lockfile, is refused. Muse Code's usage events are logged.
4. `pnpm typecheck`.
5. Mint the App token, only now, after the PR's code has run, and **push** (`fix.ts push`): the
   token reaches git through its environment, never argv or `.git/config`. A push with an App
   token starts CI; one with `GITHUB_TOKEN` wouldn't.

## Cost and time

Measured on demo-shop (T5.3): a run takes about 2 minutes, Muse Code about 100 s of it. Muse Code
is billed by tokens with no fixed price per run; the 20-step cap bounds it, and the job's log
shows each run's usage.

## Tests

```bash
pnpm --filter @intenzo/muse-fixer test   # the guards, the task, and fix + push on a real git repo with a fake Muse Code
```
