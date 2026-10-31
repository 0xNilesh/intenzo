// The worker's side of §9. Events are numbered from 0 and POSTed with the job token. A 410 means the
// job isn't its run's current one any more (superseded, cancelled, over), and the worker must stop
// at once. Sequence numbers from 1,000,000 up are the Modal shim's.
import type { WorkerEvent } from "@intenzo/core";

/** The Cloud answered 410: stop now and report nothing more. */
export class StaleJobError extends Error {
  constructor() {
    super("the Cloud says this job isn't current any more (410)");
    this.name = "StaleJobError";
  }
}

type Unnumbered<E> = E extends unknown ? Omit<E, "jobId" | "seq"> : never;
export type OutgoingEvent = Unnumbered<WorkerEvent>;

export interface JobClient {
  /** Sends the next event. Throws StaleJobError on 410. */
  send(event: OutgoingEvent): Promise<void>;
  /** Throws StaleJobError once the job shouldn't go on (GET /api/worker/alive). */
  alive(): Promise<void>;
}

export interface ClientOptions {
  /** Tries per request when the Cloud can't be reached or answers 5xx. */
  tries?: number;
  retryDelayMs?: number;
}

export function jobClient(
  job: { jobId: string; callback: { baseUrl: string; token: string } },
  { tries = 3, retryDelayMs = 500 }: ClientOptions = {},
): JobClient {
  const url = (path: string) => new URL(path, job.callback.baseUrl).toString();
  const headers = { authorization: `Bearer ${job.callback.token}` };
  let seq = 0;

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const what = `${init.method ?? "GET"} ${path}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= tries; attempt++) {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      let response: Response;
      try {
        response = await fetch(url(path), {
          ...init,
          headers: { ...headers, ...init.headers },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        lastError = err; // unreachable or timed out: try again
        continue;
      }
      if (response.status === 410) throw new StaleJobError();
      if (response.ok) return response;
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      lastError = new Error(`${what}: ${response.status} ${body.error ?? ""}`.trim());
      if (response.status < 500) break; // the Cloud refused it: trying again won't help
    }
    throw lastError;
  }

  return {
    async send(event) {
      // A retry repeats the same seq, so the Cloud stores the event once.
      const numbered = { ...event, jobId: job.jobId, seq: seq++ };
      await call("/api/worker/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(numbered),
      });
    },
    async alive() {
      await call("/api/worker/alive");
    },
  };
}
