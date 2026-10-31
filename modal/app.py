"""Intenzo's worker on Modal (ARCHITECTURE §3).

- run_job: one job, through the shim (shim.py): the worker in its own process group, stopped on
  cancellation or at the wall-clock limit, and `failed` reported unless the worker said how it ended.
- spawn, cancel: web endpoints the Cloud's outbox calls, with a bearer secret.
- sweep: every minute, POST /api/internal/sweep on the Cloud (deadlines and outbox retries), since
  Vercel's per-minute cron needs Pro.

Deploy from the repo root with `modal deploy modal/app.py` (modal/README.md).
"""

from __future__ import annotations

import hmac
import os
import urllib.request
from pathlib import Path

import modal

REPO = Path(__file__).resolve().parent.parent
# §3: Modal stops run_job after TIMEOUT_S; the shim stops the worker 30 s before that, so it can
# still report the job as failed (infra_timeout).
TIMEOUT_S = 900
LIMIT_S = TIMEOUT_S - 30
WORKER = ["node", "/repo/apps/worker/src/main.ts", "job"]

# What the worker needs, and nothing else: never the repo root, which holds the .env files and the
# App's private key. Every workspace package.json goes in, so pnpm's view of the workspace matches
# the lockfile; only core's and the worker's sources do.
MANIFESTS = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "packages/core/package.json",
    "apps/worker/package.json",
    "apps/cloud/package.json",
    "agents/muse-fixer/package.json",
    "bench/intentbench/package.json",
    "scripts/package.json",
]
# The demo ticket's criteria and their hand-written paths: the stub verify job records them (T2.7b).
SOURCES = [
    "packages/core/src",
    "packages/core/fixtures",
    "apps/worker/src",
    "fixtures/criteria",
    "fixtures/paths",
]
IGNORE = ["**/node_modules", "**/.env*", "**/*.pem", "**/*.test.ts"]

worker_image = (
    modal.Image.debian_slim(python_version="3.12")
    # ffmpeg aligns, cuts and encodes the lane videos (§21.4).
    .apt_install("curl", "ca-certificates", "ffmpeg")
    # Node 24 (.nvmrc) from NodeSource, and pnpm through corepack (package.json's packageManager).
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_24.x | bash -",
        "apt-get install -y --no-install-recommends nodejs",
        "corepack enable pnpm",
    )
)
for name in MANIFESTS:
    worker_image = worker_image.add_local_file(REPO / name, f"/repo/{name}", copy=True)
# Dependencies and Chromium come before the sources, so a code change doesn't download the browser
# again: these layers change only with the lockfile.
worker_image = worker_image.workdir("/repo").run_commands(
    "pnpm install --frozen-lockfile --prod --filter '@intenzo/worker...'",
    # Chromium and the libraries it needs, for the exact Playwright version the lockfile pins.
    "pnpm --filter @intenzo/worker exec playwright install --with-deps chromium",
)
for name in SOURCES:
    worker_image = worker_image.add_local_dir(REPO / name, f"/repo/{name}", copy=True, ignore=IGNORE)
worker_image = worker_image.add_local_python_source("shim")

# The endpoints and the sweeper only need FastAPI.
web_image = modal.Image.debian_slim(python_version="3.12").uv_pip_install("fastapi[standard]")
# FastAPI is only in the image: nothing from it may run while this file loads on a laptop.
with web_image.imports():
    from fastapi import HTTPException, Request

# MODAL_ENDPOINT_SECRET (the Cloud → Modal bearer), INTENZO_SWEEP_SECRET (Modal → Cloud) and
# INTENZO_CLOUD_URL. Created with `modal secret create` (modal/README.md).
secrets = [modal.Secret.from_name("intenzo-worker")]
# META_API_KEY only, for the worker's navigator (§20) and later its judges: the worker never gets
# the endpoints' bearer or the sweep's secret. Without it, jobs replay the hand-written paths.
model_secrets = [modal.Secret.from_name("intenzo-models")]

app = modal.App("intenzo-worker")


# Not preemptible: Modal restarts a preempted function on the same input, which for a verify job
# means a browser killed mid-recording and a second run of the same job (P4: a preemption turned a
# demo-shop run into four inconclusive verdicts). It bills CPU and memory at 3x: about $0.025 for
# a two-minute job (modal.com/docs/guide/preemption).
@app.function(
    image=worker_image,
    secrets=model_secrets,
    cpu=4.0,
    memory=8192,
    timeout=TIMEOUT_S,
    nonpreemptible=True,
)
def run_job(payload: dict) -> str:
    import shim

    return shim.run_job(payload, WORKER, LIMIT_S)


def authorize(authorization: str | None) -> None:
    expected = f"Bearer {os.environ['MODAL_ENDPOINT_SECRET']}".encode()
    if authorization is None or not hmac.compare_digest(authorization.encode(), expected):
        raise HTTPException(status_code=401, detail="missing or wrong bearer token")


@app.function(image=web_image, secrets=secrets)
@modal.fastapi_endpoint(method="POST")
def spawn(job: dict, request: Request) -> dict:
    """Starts run_job on the job and answers with its call id, which cancel takes."""
    authorize(request.headers.get("authorization"))
    call = run_job.spawn(job)
    return {"callId": call.object_id}


@app.function(image=web_image, secrets=secrets)
@modal.fastapi_endpoint(method="POST")
def cancel(body: dict, request: Request) -> dict:
    """Cancels a spawned job: the shim stops its process group and reports failed (cancelled)."""
    authorize(request.headers.get("authorization"))
    modal.FunctionCall.from_id(body["callId"]).cancel()
    return {"cancelled": body["callId"]}


@app.function(image=web_image, secrets=secrets, schedule=modal.Cron("* * * * *"))
def sweep() -> None:
    request = urllib.request.Request(
        os.environ["INTENZO_CLOUD_URL"].rstrip("/") + "/api/internal/sweep",
        method="POST",
        headers={"authorization": f"Bearer {os.environ['INTENZO_SWEEP_SECRET']}"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        print(f"sweep: {response.status} {response.read(500).decode()}")
