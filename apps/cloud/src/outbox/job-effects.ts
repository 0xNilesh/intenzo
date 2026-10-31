// The outbox's job effects (§16.3, §16.4): spawn a run's job on Modal when the run starts verifying,
// and cancel it when the run ends any other way (superseded, past its deadline). Until T2.7 makes
// it a VerifyJob, the job is a placeholder sleep job, which exercises Modal, the shim and the job
// protocol end to end and then finishes inconclusive.
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../db/db.ts";
import { runs } from "../db/schema.ts";
import type { ModalSettings } from "../env.ts";
import { signJobToken, tokenExpiry } from "../jobs/token.ts";
import type { EffectExecutor } from "./drain.ts";

/** How long the placeholder job sleeps before it finishes. */
export const PLACEHOLDER_SECONDS = 60;
/** §16.1's verifying deadline, for a run that somehow has none. */
const DEFAULT_DEADLINE_MS = 15 * 60_000;

export interface JobEffectDeps {
  db: Db;
  modal: ModalSettings;
  /** INTENZO_JOB_SECRET, which signs the job's token. */
  jobSecret: string;
  newJobId: () => string;
  now: () => Date;
}

export function jobExecutors(deps: JobEffectDeps): Record<string, EffectExecutor> {
  return { spawn_job: spawnExecutor(deps), cancel_job: cancelExecutor(deps) };
}

const Spawned = z.object({ callId: z.string().min(1) });

export function spawnExecutor(deps: JobEffectDeps): EffectExecutor {
  return {
    run: async (row) => {
      const runId = row.runId!;
      // A fresh job id on every attempt: a job an earlier attempt may have started is stale from
      // here on (410) and stops itself, so a run never has two live jobs.
      const jobId = deps.newJobId();
      const [run] = await deps.db
        .update(runs)
        .set({ currentJobId: jobId, modalCallId: null })
        .where(and(eq(runs.id, runId), eq(runs.state, "verifying")))
        .returning();
      if (!run) return null; // the run has moved on: nothing to start
      const deadlineAt = run.deadlineAt ?? new Date(deps.now().getTime() + DEFAULT_DEADLINE_MS);
      const job = {
        type: "sleep",
        jobId,
        runId,
        deadlineAt: deadlineAt.toISOString(),
        callback: {
          baseUrl: deps.modal.cloudUrl,
          token: signJobToken(deps.jobSecret, { jobId, runId, exp: tokenExpiry(deadlineAt) }),
        },
        seconds: PLACEHOLDER_SECONDS,
        aliveEverySeconds: 5,
      };
      const { callId } = await callModal(deps.modal.spawnUrl, deps.modal.secret, job, Spawned);
      await deps.db
        .update(runs)
        .set({ modalCallId: callId })
        .where(and(eq(runs.id, runId), eq(runs.currentJobId, jobId)));
      return callId;
    },
  };
}

export function cancelExecutor(deps: JobEffectDeps): EffectExecutor {
  return {
    run: async (row) => {
      const [run] = await deps.db
        .select({ callId: runs.modalCallId })
        .from(runs)
        .where(eq(runs.id, row.runId!));
      // Never spawned, or not yet: there's nothing to cancel, and a job spawned later finds its run
      // over at its first /alive and stops.
      if (!run?.callId) return null;
      await callModal(deps.modal.cancelUrl, deps.modal.secret, { callId: run.callId }, z.unknown());
      return run.callId;
    },
  };
}

async function callModal<T>(url: string, secret: string, body: unknown, schema: z.ZodType<T>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`Modal ${new URL(url).hostname}: ${response.status} ${text}`.trim());
  }
  return schema.parse(await response.json());
}
