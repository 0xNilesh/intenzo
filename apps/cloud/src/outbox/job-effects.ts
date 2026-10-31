// The outbox's job effects (§16.3, §16.4): spawn a run's VerifyJob on Modal when the run starts
// verifying (§8), and cancel it when the run ends any other way (superseded, past its deadline).
import { SavedPath, VerifyJob } from "@intenzo/core";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../db/db.ts";
import { repoConfig } from "../db/repos.ts";
import { intentVersions, repos, runGroups, runs, savedPaths } from "../db/schema.ts";
import type { ModalSettings } from "../env.ts";
import { signJobToken, tokenExpiry } from "../jobs/token.ts";
import { type RepoSecrets, repoSecrets } from "../secrets/repo-secrets.ts";
import type { EffectExecutor } from "./drain.ts";

/** §16.1's verifying deadline, for a run that somehow has none. */
const DEFAULT_DEADLINE_MS = 15 * 60_000;

export interface JobEffectDeps {
  db: Db;
  modal: ModalSettings;
  /** INTENZO_JOB_SECRET, which signs the job's token. */
  jobSecret: string;
  /** INTENZO_SECRETS_KEY, which opens the repos' sealed secrets; null when it isn't set. */
  secretsKey: Buffer | null;
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
      const [ctx] = await deps.db
        .select({ group: runGroups, repo: repos })
        .from(runs)
        .innerJoin(runGroups, eq(runs.runGroupId, runGroups.id))
        .innerJoin(repos, eq(runGroups.repoId, repos.id))
        .where(eq(runs.id, runId));
      if (!ctx) return null;
      // §29: nothing secret reaches a fork's code. Opened before the job becomes current, so a
      // job that can't be built leaves the run as it was.
      const secrets = ctx.group.fromFork ? null : jobSecrets(deps.secretsKey, ctx.repo);
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
      const job = VerifyJob.parse({
        type: "verify",
        jobId,
        runId,
        deadlineAt: deadlineAt.toISOString(),
        callback: {
          baseUrl: deps.modal.cloudUrl,
          token: signJobToken(deps.jobSecret, { jobId, runId, exp: tokenExpiry(deadlineAt) }),
        },
        config: repoConfig(ctx.repo),
        // Until P4 there's no context bundle, and the job computes the intent itself (§19 step 0).
        bundleUrl: null,
        intent: null,
        prUrl: run.prUrl,
        baseUrl: run.baseUrl,
        baseSha: run.baseSha,
        secrets,
        cachedPaths: await cachedPaths(deps.db, ctx.group.id),
      });
      const { callId } = await callModal(deps.modal.spawnUrl, deps.modal.secret, job, Spawned);
      await deps.db
        .update(runs)
        .set({ modalCallId: callId })
        .where(and(eq(runs.id, runId), eq(runs.currentJobId, jobId)));
      return callId;
    },
  };
}

/**
 * The group's saved paths for its latest intent version (§19 3a). The job works out its intent
 * at step 0, so the latest one stands in for it; a path that no longer fits the app breaks on
 * replay and is explored again (T3.5).
 */
export async function cachedPaths(db: Db, groupId: number): Promise<SavedPath[]> {
  const [latest] = await db
    .select({ id: intentVersions.id })
    .from(intentVersions)
    .where(eq(intentVersions.runGroupId, groupId))
    .orderBy(desc(intentVersions.id))
    .limit(1);
  if (!latest) return [];
  const rows = await db
    .select({ path: savedPaths.pathJson })
    .from(savedPaths)
    .where(and(eq(savedPaths.runGroupId, groupId), eq(savedPaths.intentVersionId, latest.id)));
  return rows.flatMap((row) => {
    const parsed = SavedPath.safeParse(row.path);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The repo's secrets for its job; a repo with sealed secrets and no key to open them is an error. */
function jobSecrets(key: Buffer | null, repo: typeof repos.$inferSelect): RepoSecrets {
  if (!repo.hookSecretEnc && !repo.bypassEnc && !repo.usersEnc) return {};
  if (!key) {
    throw new Error(`${repo.fullName} has sealed secrets, but INTENZO_SECRETS_KEY isn't set`);
  }
  return repoSecrets(key, repo);
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
