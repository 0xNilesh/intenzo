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

## `intenzo job` (T2.5a)

Runs one job (ARCHITECTURE §8), read from a file or stdin, which is how the Modal shim hands it over,
and reports to the Cloud with the job's token (§9):

```bash
node apps/worker/src/main.ts job job.json
```

- **Events** are numbered from 0. One the Cloud couldn't take (unreachable, 5xx) is sent again with
  the same seq, which the Cloud stores once.
- **A 410**, to an event or to `GET /api/worker/alive`, means the job isn't current any more (its run
  was superseded, cancelled or is over). The worker stops at once and reports nothing more.
- **Exit code:** 0 finished; 1 failed (reported); 3 stopped on a 410. The shim reports `failed`
  itself only on another code.
- **Files** go straight to Blob with `uploadArtifacts()`: the Cloud presigns one URL per file under
  `runs/{runId}/`, by `takePath()` from core, and the worker PUTs it. Videos go to the private
  store; GIFs and stills to the public one (ARCHITECTURE §28).
- **Jobs:**
  - A `sleep` job (`seconds`, `aliveEverySeconds`) exercises the protocol and the shim.
  - A `stub` job (T2.7a) reports the demo's criteria (`fixtures/criteria`, C1–C4) with fixed
    verdicts, C2 failing and the others passing, then finishes `fail`. The Cloud spawns it until
    the worker records for real (T2.7b).
  - A `verify` job answers `failed` (`not_implemented`) until T2.7b.

## Tests

```bash
pnpm --filter @intenzo/worker test    # unit tests for the CLI's argument parsing and output
```
