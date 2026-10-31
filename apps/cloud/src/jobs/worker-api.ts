// The worker's two routes (§9, §12). Each request carries its job token. A job that isn't its run's
// current one any more (superseded, cancelled, or the run is done) is answered 410, and the worker
// aborts. Events are stored once per (jobId, seq), and finished/failed end the run.
import { WorkerEvent } from "@intenzo/core";
import { eq } from "drizzle-orm";

import type { Db } from "../db/db.ts";
import { jobEvents, runs } from "../db/schema.ts";
import { advance } from "../runs/advance.ts";
import { requestComment, RESULT_EVENTS, storeResult } from "./results.ts";
import type { Fact } from "../runs/transition.ts";
import { bearerToken, type JobClaims, verifyJobToken } from "./token.ts";

export interface WorkerApiDeps {
  db: Db;
  /** INTENZO_JOB_SECRET */
  secret: string;
  now: () => Date;
  newRunId: () => string;
  /** Runs the outbox's due effects after a run changed. */
  drain: () => Promise<unknown>;
  /** One line per event. Never a token or an event's payload. */
  log: (line: string) => void;
}

/** §9: bodies stay under 1 MB; media travel as ArtifactRefs. */
export const MAX_EVENT_BYTES = 1_000_000;

const reply = (status: number, body: object) => Response.json(body, { status });
const short = (id: string) => id.slice(0, 8);

type RunRow = typeof runs.$inferSelect;

/** The job is its run's current one and the run isn't over (§9's stale guard). */
export function isCurrentJob(run: RunRow | undefined, jobId: string): run is RunRow {
  return run !== undefined && run.currentJobId === jobId && run.state !== "done";
}

/** The job token's claims and its run, or the 401 to answer. Every worker route starts here. */
export async function authorizeJob(
  request: Request,
  deps: Pick<WorkerApiDeps, "db" | "secret" | "now">,
): Promise<{ claims: JobClaims; run: RunRow | undefined } | Response> {
  const token = bearerToken(request);
  const nowS = Math.floor(deps.now().getTime() / 1000);
  const claims = token === null ? null : verifyJobToken(deps.secret, token, nowS);
  if (!claims) return reply(401, { error: "missing, invalid or expired job token" });
  const [run] = await deps.db.select().from(runs).where(eq(runs.id, claims.runId));
  return { claims, run };
}

/** POST /api/worker/events */
export async function handleWorkerEvent(request: Request, deps: WorkerApiDeps): Promise<Response> {
  const auth = await authorizeJob(request, deps);
  if (auth instanceof Response) return auth;
  const { claims, run } = auth;

  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_EVENT_BYTES) {
    return reply(413, { error: "events stay under 1 MB; send media as ArtifactRefs (§9)" });
  }
  let event: WorkerEvent;
  try {
    event = WorkerEvent.parse(JSON.parse(text));
  } catch {
    return reply(400, { error: "the body isn't a worker event (§9)" });
  }
  if (event.jobId !== claims.jobId) {
    return reply(403, { error: "the event names another job than its token" });
  }
  const what = `job ${short(claims.jobId)} ${event.kind} #${event.seq}`;
  if (!isCurrentJob(run, claims.jobId)) {
    deps.log(`run ${short(claims.runId)}: ${what} refused: the job isn't current (410)`);
    return reply(410, { error: "this job isn't current any more: stop" });
  }

  const [stored] = await deps.db
    .insert(jobEvents)
    .values({
      jobId: event.jobId,
      runId: run.id,
      seq: event.seq,
      kind: event.kind,
      payloadJson: event,
      receivedAt: deps.now(),
    })
    .onConflictDoNothing({ target: [jobEvents.jobId, jobEvents.seq] })
    .returning({ id: jobEvents.id });
  if (!stored) return reply(200, { status: "duplicate" });
  deps.log(`run ${short(run.id)}: ${what}`);

  const fact: Fact | null =
    event.kind === "finished"
      ? { kind: "job_finished", runId: run.id, outcome: event.outcome }
      : event.kind === "failed"
        ? { kind: "job_failed", runId: run.id, code: event.error.code }
        : null;
  if (fact) {
    const decision = await advance(deps.db, run.runGroupId, fact, {
      now: deps.now(),
      newRunId: deps.newRunId,
    });
    if (decision.effects.length > 0) await deps.drain();
  } else if (RESULT_EVENTS.has(event.kind)) {
    await storeResult(deps.db, run, event);
    await requestComment(deps.db, run.runGroupId);
    await deps.drain();
  }
  return reply(202, { status: "accepted" });
}

/** GET /api/worker/alive: whether the job should go on (§12). */
export async function handleAlive(request: Request, deps: WorkerApiDeps): Promise<Response> {
  const auth = await authorizeJob(request, deps);
  if (auth instanceof Response) return auth;
  if (!isCurrentJob(auth.run, auth.claims.jobId)) {
    return reply(410, { error: "this job isn't current any more: stop" });
  }
  return reply(200, { alive: true });
}
