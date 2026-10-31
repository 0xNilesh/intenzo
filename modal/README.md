# modal/: Intenzo's worker on Modal

ARCHITECTURE §3. The Modal app `intenzo-worker` runs each job in its own container, stops it cleanly
when the Cloud cancels it, and calls the Cloud's sweep route every minute.

| File           | What it is                                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.py`       | The Modal app: `run_job` (4 cores, 8 GiB, 900 s), the `spawn` and `cancel` web endpoints the Cloud's outbox calls, and the `sweep` cron                                      |
| `shim.py`      | What `run_job` does: the worker (`intenzo job`) in its own process group, stopped on cancellation or at the limit, and `failed` reported unless the worker said how it ended |
| `test_shim.py` | The shim's tests: `pnpm test:modal` (Python's standard library, with Node 24 on PATH)                                                                                        |

## How a job runs

1. **Starting a job:** the Cloud's `spawn_job` effect POSTs the job to `spawn`, with a bearer secret.
   `spawn` starts `run_job` and answers with its call id.
2. **Running it:** `run_job` hands the job to the worker on stdin. The worker reports to the Cloud
   with the job's token (ARCHITECTURE §9).
3. **Cancelling it:** the Cloud's `cancel_job` effect POSTs the call id to `cancel`. The shim stops
   the worker's whole process group: SIGTERM, then SIGKILL after 5 s. It then reports `failed`
   (`cancelled`).
4. **Ending it:**
   - The shim also stops the group 30 s before Modal's 900 s timeout, and reports `infra_timeout`.
   - It reports `crash` if the worker exits with an unexpected code.
   - Exit 0 (finished), 1 (failed, reported) and 3 (stale, told to stop) need no report.

## Deploying

Once, with a Modal account:

```bash
pipx install modal
modal token new                                   # opens the browser to log in
modal secret create intenzo-worker --from-dotenv .env.intenzo-modal
```

`.env.intenzo-modal` (gitignored, mode 600) holds:

- `MODAL_ENDPOINT_SECRET`: the Cloud's bearer token for `spawn` and `cancel`
- `INTENZO_SWEEP_SECRET`: what `sweep` sends to the Cloud
- `INTENZO_CLOUD_URL`

Then, from the repo root:

```bash
modal deploy modal/app.py
```

The deploy prints the `spawn` and `cancel` URLs. They go on Vercel as `MODAL_SPAWN_URL` and
`MODAL_CANCEL_URL`, next to the same `MODAL_ENDPOINT_SECRET`, `INTENZO_SWEEP_SECRET` and
`INTENZO_CLOUD_URL` (apps/cloud/README.md). Until all four are set, the Cloud spawns nothing.

**The image** holds Node 24, pnpm, and the worker's and core's sources with their production
dependencies. It never holds the repo root, which has the `.env` files and the App's private key.

## Costs

Modal's Starter plan includes $30 of compute a month (modal.com/pricing, 2026-10-31). Rates: $0.0000131 per
core-second and $0.00000222 per GiB-second.

- **`run_job`** (4 cores, 8 GiB) costs about $0.25 an hour while it runs. Until T2.7, a job is a
  60 s placeholder: about $0.004.
- **The cron** starts a small container once a minute: a few cents a day.
