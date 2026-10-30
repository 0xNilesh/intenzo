# @intenzo/worker

The verification worker (VerifyJob execution on Modal, from P2) and the local `intenzo` CLI.

```bash
pnpm intenzo <command> [options]      # = node apps/worker/src/main.ts
```

## `intenzo record` (T1.6)

Records one hand-written `SavedPath` with the observation protocol (ARCHITECTURE §21.3) on the PR
app and, optionally, the base app, then prints each side's status, video alignment and readings
(label, phase, time from Tt, kind, value).

```bash
pnpm intenzo record --path fixtures/paths/C2.json --pr http://localhost:3001 --base http://localhost:3000
```

| Option              | Default                                                 |
| ------------------- | ------------------------------------------------------- |
| `--criterion`       | `fixtures/criteria/<the path's criterion id>.json`      |
| `--out`             | `out/runs/local-<UTC time>` (the run root, gitignored)  |
| `--config`          | `packages/core/fixtures/config/demo-shop.intenzo.yml`   |
| `--hook-secret-env` | `DEMO_SHOP_HOOK_SECRET`                                 |
| `--bypass-env`      | `DEMO_SHOP_BYPASS_SECRET` (only sent to non-local apps) |

- **Identity:** when the config has `isolation.session_hook`, every side gets a brand-new user from
  that hook. The config only names secrets, so the hook secret is read from `.env` under the
  `--hook-secret-env` name. It's never printed.
- **Output:** each take goes to `<run root>/<criterion>/<side>/take-1`: `raw.webm`, `trace.zip`,
  `shot.png`, `shot-annotated.png`, `boxes.json` and `lane.json` (a `LaneResult`).
- **Exit code:** 0, or 1 if a lane ended in `error` or its video couldn't be aligned; 2 for usage
  errors. `trigger_absent` on the base side is a normal result (the base app may not have the
  feature yet).
- **Needs** Playwright's Chromium and `ffmpeg` (for the alignment). No model calls; it costs nothing.

## Tests

```bash
pnpm --filter @intenzo/worker test    # unit tests for the CLI's argument parsing and output
```
