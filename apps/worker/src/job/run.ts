// Runs one job and reports how it went (§9). Whatever happens, the Cloud hears of it: finished, or
// failed with a code. The one exception is a 410, after which the worker stops without a word.
import { type JobClient, jobClient, StaleJobError } from "./client.ts";
import { JobPayload, type SleepJob } from "./payload.ts";

/** Exit codes: the Modal shim reports `failed` itself unless the job finished or was stale. */
export const EXIT = { finished: 0, failed: 1, stale: 3 } as const;

export interface RunOptions {
  /** A client for the job; by default one that POSTs to its callback URL. */
  client?: (job: JobPayload) => JobClient;
}

export async function runJob(payload: unknown, options: RunOptions = {}): Promise<number> {
  // A payload that doesn't parse has no trustworthy callback to report to: the shim reports it.
  const job = JobPayload.parse(payload);
  const client = (options.client ?? jobClient)(job);
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
      case "verify":
        await client.send({
          kind: "failed",
          error: { code: "not_implemented", message: "this worker can't verify yet (T2.7)" },
        });
        return EXIT.failed;
    }
  } catch (err) {
    if (err instanceof StaleJobError) return EXIT.stale;
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
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
