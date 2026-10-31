// Runs one job and reports how it went (§9). Whatever happens, the Cloud hears of it: finished, or
// failed with a code. The one exception is a 410, after which the worker stops without a word.
import type { RunOutcome } from "@intenzo/core";

import { type JobClient, jobClient, StaleJobError } from "./client.ts";
import { JobPayload, type SleepJob } from "./payload.ts";
import { browserRecorder } from "./recorder.ts";
import { type Recorder, redactor, verify } from "./verify.ts";

/** Exit codes: the Modal shim reports `failed` itself unless the job finished or was stale. */
export const EXIT = { finished: 0, failed: 1, stale: 3 } as const;

export interface RunOptions {
  /** A client for the job; by default one that POSTs to its callback URL. */
  client?: (job: JobPayload) => JobClient;
  /** Records the verify job's lanes; by default in Chromium (recorder.ts). */
  recorder?: () => Recorder;
  /** Where progress goes (Modal's logs); never a secret. */
  log?: (line: string) => void;
}

export async function runJob(payload: unknown, options: RunOptions = {}): Promise<number> {
  // A payload that doesn't parse has no trustworthy callback to report to: the shim reports it.
  const job = JobPayload.parse(payload);
  const client = (options.client ?? jobClient)(job);
  const redact = redactor(job.type === "verify" ? job.secrets : null);
  const startedAt = Date.now();
  try {
    await client.send({ kind: "started" });
    switch (job.type) {
      case "sleep":
        await sleep(job, client);
        await client.send({
          kind: "finished",
          outcome: "inconclusive",
          costUsd: 0,
          timings: { total_ms: Date.now() - startedAt },
        });
        return EXIT.finished;
      case "verify": {
        const recorder = (options.recorder ?? browserRecorder)();
        let outcome: RunOutcome;
        try {
          outcome = await verify(job, client, recorder, options.log ?? console.log);
        } finally {
          await recorder.close();
        }
        await client.send({
          kind: "finished",
          outcome,
          costUsd: 0, // no model calls yet: the verdicts are the stub's
          timings: { total_ms: Date.now() - startedAt },
        });
        return EXIT.finished;
      }
    }
  } catch (err) {
    if (err instanceof StaleJobError) return EXIT.stale;
    const message = redact(err instanceof Error ? err.message : String(err)).slice(0, 500);
    await client.send({ kind: "failed", error: { code: "crash", message } }).catch(() => {});
    return EXIT.failed;
  }
}

/** Sleeps for the job's seconds, asking /alive between naps, so a superseded job stops soon. */
async function sleep(job: SleepJob, client: JobClient): Promise<void> {
  const until = Date.now() + job.seconds * 1000;
  for (let left = until - Date.now(); left > 0; left = until - Date.now()) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(job.aliveEverySeconds * 1000, left)),
    );
    await client.alive();
  }
}
