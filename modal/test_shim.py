"""Tests for modal/shim.py: `python3 -m unittest discover -s modal` from the repo root (or
`pnpm test:modal`). They need Node 24 on PATH; the first one runs the real worker CLI."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import shim  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
JOB = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b"
RUN = "ea44d35d-4baa-4f81-ac92-08285fae4058"


class FakeCloud:
    """The Cloud's worker routes on a local port: records events, answers 202 and alive 200."""

    def __init__(self) -> None:
        self.events: list[dict] = []
        cloud = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers["content-length"]))
                cloud.events.append(json.loads(body))
                self.send_response(202)
                self.end_headers()

            def do_GET(self) -> None:
                self.send_response(200)
                self.end_headers()

            def log_message(self, *_args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def sleep_job(base_url: str, seconds: float = 60) -> dict:
    return {
        "type": "sleep",
        "jobId": JOB,
        "runId": RUN,
        "deadlineAt": "2026-10-31T09:15:00.000Z",
        "callback": {"baseUrl": base_url, "token": "job-token"},
        "seconds": seconds,
        "aliveEverySeconds": 0.2,
    }


def wait_for(condition, seconds: float, what: str) -> None:
    deadline = time.monotonic() + seconds
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        time.sleep(0.05)


def node(script: str) -> list[str]:
    return ["node", "-e", script]


class CancelledSleepJob(unittest.TestCase):
    """ROADMAP T2.5b: a sleep job, cancelled → the process group is gone and the Cloud receives
    failed (cancelled)."""

    def test_cancel_stops_the_group_and_reports_cancelled(self) -> None:
        cloud = FakeCloud()
        self.addCleanup(cloud.close)
        shim_cmd = [sys.executable, str(REPO / "modal" / "shim.py"), "120", "node", "apps/worker/src/main.ts", "job"]
        proc = subprocess.Popen(shim_cmd, cwd=REPO, stdin=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        assert proc.stdin and proc.stderr
        proc.stdin.write(json.dumps(sleep_job(cloud.url)))
        proc.stdin.close()

        lines: list[str] = []
        reader = threading.Thread(target=lambda: lines.extend(proc.stderr), daemon=True)
        reader.start()
        self.addCleanup(proc.stderr.close)
        self.addCleanup(reader.join, 5)
        wait_for(lambda: any(e["kind"] == "started" for e in cloud.events), 20, "the worker's `started`")
        pgid = int(next(l for l in lines if "process group" in l).split()[-1])
        self.assertEqual(os.getpgid(pgid), pgid, "the worker should lead its own process group")

        proc.send_signal(signal.SIGTERM)  # how the test stands in for Modal's cancellation
        self.assertEqual(proc.wait(timeout=15), 130)
        self.assertFalse(shim.group_alive(pgid), "the worker's process group outlived the cancel")
        with self.assertRaises(ProcessLookupError, msg="the worker outlived the cancel"):
            os.kill(pgid, 0)
        self.assertEqual(
            [(e["kind"], e["seq"], e.get("error", {}).get("code")) for e in cloud.events],
            [("started", 0, None), ("failed", shim.SHIM_SEQ, "cancelled")],
        )


class Endings(unittest.TestCase):
    """How the worker ended decides whether the shim reports anything."""

    def run_shim(self, command: list[str], limit_s: float = 30) -> tuple[str, list[dict]]:
        posted: list[dict] = []
        ended = shim.run_job(sleep_job("http://127.0.0.1:9"), command, limit_s, post=lambda _p, e: posted.append(e))
        return ended, posted

    def test_finished_failed_and_stale_say_nothing_more(self) -> None:
        for code, ended in [(0, "finished"), (1, "failed"), (3, "stale")]:
            with self.subTest(code=code):
                self.assertEqual(self.run_shim(node(f"process.exit({code})")), (ended, []))

    def test_a_crash_is_reported(self) -> None:
        ended, posted = self.run_shim(node("process.exit(7)"))
        self.assertEqual(ended, "crash")
        self.assertEqual(
            posted,
            [{"kind": "failed", "jobId": JOB, "seq": shim.SHIM_SEQ, "error": {"code": "crash", "message": "the worker exited with code 7"}}],
        )

    def test_the_wall_clock_limit_stops_the_group_and_is_reported(self) -> None:
        ended, posted = self.run_shim(node("setTimeout(() => {}, 60_000)"), limit_s=0.5)
        self.assertEqual(ended, "infra_timeout")
        self.assertEqual([e["error"]["code"] for e in posted], ["infra_timeout"])

    def test_a_worker_that_ignores_sigterm_gets_sigkill(self) -> None:
        self.addCleanup(setattr, shim, "GRACE_S", shim.GRACE_S)
        shim.GRACE_S = 0.3
        script = "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60_000)"
        pids: list[int] = []
        real_popen = subprocess.Popen

        def recording_popen(*args, **kwargs):  # type: ignore[no-untyped-def]
            proc = real_popen(*args, **kwargs)
            pids.append(proc.pid)
            return proc

        shim.subprocess.Popen = recording_popen  # type: ignore[misc]
        self.addCleanup(lambda: setattr(shim.subprocess, "Popen", real_popen))
        started = time.monotonic()
        ended, _ = self.run_shim(node(script), limit_s=0.5)
        self.assertEqual(ended, "infra_timeout")
        self.assertFalse(shim.group_alive(pids[0]), "a worker ignoring SIGTERM outlived its job")
        # Without SIGKILL the shim would wait for the worker to give up by itself, a minute later.
        self.assertLess(time.monotonic() - started, 10)

    def test_what_the_worker_leaves_behind_is_stopped_too(self) -> None:
        # The worker starts a long-lived child in its group (as a browser would) and exits.
        script = "require('node:child_process').spawn('sleep', ['60'], { stdio: 'ignore' }); process.exit(0)"
        proc_pgids: list[int] = []
        real_popen = subprocess.Popen

        def recording_popen(*args, **kwargs):  # type: ignore[no-untyped-def]
            proc = real_popen(*args, **kwargs)
            proc_pgids.append(proc.pid)
            return proc

        shim.subprocess.Popen = recording_popen  # type: ignore[misc]
        self.addCleanup(lambda: setattr(shim.subprocess, "Popen", real_popen))
        self.assertEqual(self.run_shim(node(script)), ("finished", []))
        self.assertFalse(shim.group_alive(proc_pgids[0]), "the worker's child outlived the job")


if __name__ == "__main__":
    unittest.main()
