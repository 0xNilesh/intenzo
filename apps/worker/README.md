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

## `intenzo explore` (T3.4)

Lets the navigator (ARCHITECTURE §20.3) find its own way to one criterion's trigger on the PR app,
then writes the `SavedPath` it leaves behind, which `intenzo record` replays.

```bash
pnpm intenzo explore --criterion fixtures/criteria/C2.json --pr http://localhost:3001
pnpm intenzo record --path out/paths/C2.json --pr http://localhost:3001 --base http://localhost:3000
```

| Option                               | Default                                               |
| ------------------------------------ | ----------------------------------------------------- |
| `--out`                              | `out/paths/<criterion>.json`                          |
| `--steps`                            | 25 (the time budget is 120 s)                         |
| `--model`                            | `muse-wonder-1.0`                                     |
| `--config`                           | `packages/core/fixtures/config/demo-shop.intenzo.yml` |
| `--hook-secret-env` / `--bypass-env` | as for `intenzo record`                               |

- **The config supplies** the start path (`start.default`), the test data the model may use
  (`data`), the deny list and the session hook.
- **Cost:** one Wonder call per step. On demo-shop, C1–C4 each took 2 steps, about 3k tokens and
  $0.012 at Wonder's list price ($4 / $0.20 / $20 per million input / cached / output tokens).
  Needs `META_API_KEY` in `.env`.
- **Exit code:** 0 when a path was found, 1 for `setup_failed` or `trigger_absent`, 2 for usage
  errors.

## `intenzo intent` (T4.1, T4.2)

Reads a ticket's criteria with Spark 1.3 (ARCHITECTURE §18, `intent.v1`) and prints them, with
the tokens and the list-price cost. A checklist ticket gets one criterion per item. With
`--video`, the PM's recording is transcribed (Voice Transcribe) and watched by Spark, and each
criterion says when in the recording it comes.

```bash
pnpm intenzo intent --ticket fixtures/tickets/42.md [--out out/intent.json]
pnpm intenzo intent --ticket fixtures/tickets/5.md --video probes/demo/pm-ticket.mp4
```

The ticket file's first `# ` line is its title. One call, two if the reply breaks the checklist
rule: about $0.02. Needs `META_API_KEY` in `.env`.

## `intenzo job` (T2.5a, T2.7b)

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
  - A `verify` job (§8, §19) is what the Cloud spawns. Until the navigator (P3) and the judges
    (P4), it records the demo ticket's criteria (`fixtures/criteria`, C1–C4) along their
    hand-written paths (`fixtures/paths`) on the PR preview and the base preview, uploads each
    lane's `human.mp4` to the private store, and reports the stub's fixed verdicts (C2 fails, the
    others pass) citing the PR recording. A PR side that doesn't complete makes its criterion
    inconclusive (§22.1). It needs Chromium and ffmpeg, as the Modal image has.
  - A `sleep` job (`seconds`, `aliveEverySeconds`) exercises the protocol and the shim.
- **Secrets:** the job's hook secret, bypass and test passwords are replaced with `[redacted]` in
  every lane, log line and crash message before anything leaves the worker.

## Tests

```bash
pnpm --filter @intenzo/worker test    # unit tests for the CLI's argument parsing and output
```
