"""The Modal shim's logic (ARCHITECTURE §3), apart from modal/app.py so it runs and is tested
without Modal.

It starts the worker (`intenzo job`) in its own process group and hands it the job on stdin. When
the job is cancelled, or runs into the wall-clock limit, it stops the whole group: SIGTERM, then
SIGKILL after 5 s, so no browser or ffmpeg outlives its job. And it makes sure the Cloud hears how
the job ended: unless the worker finished (exit 0), reported its own failure (1) or was told its job
is stale (3), the shim reports `failed` itself (§9).
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Callable

# The worker's exit codes (apps/worker/src/job/run.ts).
FINISHED, REPORTED_FAILURE, STALE = 0, 1, 3
# §9: sequence numbers from here up are the shim's, so its event can't collide with the worker's.
SHIM_SEQ = 1_000_000
# SIGTERM first; SIGKILL whatever is left after this many seconds.
GRACE_S = 5.0

PostEvent = Callable[[dict, dict], None]


def log(line: str) -> None:
    print(f"shim: {line}", file=sys.stderr, flush=True)


def post_event(payload: dict, event: dict) -> None:
    """POSTs one event to the Cloud with the job's token; three tries. Never raises."""
    callback = payload["callback"]
    request = urllib.request.Request(
        callback["baseUrl"].rstrip("/") + "/api/worker/events",
        data=json.dumps(event).encode(),
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {callback['token']}",
        },
    )
    for attempt in range(1, 4):
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                log(f"reported {event['kind']} ({event['error']['code']}): {response.status}")
                return
        except urllib.error.HTTPError as err:
            # 410: the job isn't current any more, and the Cloud doesn't want to hear about it.
            if err.code < 500:
                log(f"reported {event['kind']} ({event['error']['code']}): {err.code}")
                return
        except OSError as err:
            log(f"couldn't reach the Cloud (try {attempt}): {err}")
        time.sleep(attempt)


def group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def stop_group(proc: subprocess.Popen) -> None:
    """Stops the worker's whole process group: SIGTERM, then SIGKILL after the grace period."""
    pgid = proc.pid  # start_new_session=True: the worker leads its own group
    proc.poll()  # reap the worker if it has exited, so only live members count
    if not group_alive(pgid):
        return
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + GRACE_S
    while time.monotonic() < deadline:
        proc.poll()
        if not group_alive(pgid):
            return
        time.sleep(0.1)
    log(f"process group {pgid} outlived SIGTERM by {GRACE_S:.0f} s: SIGKILL")
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait()


def run_job(
    payload: dict,
    command: list[str],
    limit_s: float,
    post: PostEvent = post_event,
) -> str:
    """Runs the worker on one job and returns how it ended: finished, failed, stale, crash or
    infra_timeout. A cancellation (any exception, such as Modal's or a signal's) is re-raised after
    the group is stopped and `failed (cancelled)` is reported."""
    proc = subprocess.Popen(command, stdin=subprocess.PIPE, start_new_session=True)
    log(f"worker started in process group {proc.pid}")
    ended = "crash"
    exit_code: int | None = None
    try:
        assert proc.stdin is not None
        proc.stdin.write(json.dumps(payload).encode())
        proc.stdin.close()
        deadline = time.monotonic() + limit_s
        # Short waits, so a cancellation is noticed within a second whatever form it takes.
        while exit_code is None:
            if time.monotonic() >= deadline:
                ended = "infra_timeout"
                return ended
            try:
                exit_code = proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
        ended = {FINISHED: "finished", REPORTED_FAILURE: "failed", STALE: "stale"}.get(
            exit_code, "crash"
        )
        return ended
    except BaseException as err:
        # Modal's docs don't say what a cancelled input sees: the log line records it.
        log(f"cancelled by {type(err).__module__}.{type(err).__name__}: {err}")
        ended = "cancelled"
        raise
    finally:
        stop_group(proc)
        log(f"job {payload['jobId'][:8]} ended: {ended}")
        if ended in ("crash", "infra_timeout", "cancelled"):
            message = {
                "crash": f"the worker exited with code {exit_code}",
                "infra_timeout": f"the job ran past its {limit_s:.0f} s wall-clock limit",
                "cancelled": "the job was cancelled",
            }[ended]
            post(
                payload,
                {
                    "kind": "failed",
                    "jobId": payload["jobId"],
                    "seq": SHIM_SEQ,
                    "error": {"code": ended, "message": message},
                },
            )


def main() -> int:
    """`python3 modal/shim.py <limit seconds> <command…>` with the job on stdin: for the tests and
    for running the shim by hand. SIGTERM and SIGINT count as a cancellation."""

    def cancel(signum: int, _frame: object) -> None:
        raise KeyboardInterrupt(f"signal {signum}")

    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    limit_s, command = float(sys.argv[1]), sys.argv[2:]
    payload = json.load(sys.stdin)
    try:
        ended = run_job(payload, command, limit_s)
    except KeyboardInterrupt:
        return 130
    return 0 if ended in ("finished", "stale") else 1


if __name__ == "__main__":
    sys.exit(main())
