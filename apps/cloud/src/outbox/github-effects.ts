// The outbox's GitHub effects (§16.4): the Intenzo check run of each run, and the one comment of
// each run group. Both are rendered from the database when they run, and each takes a Postgres
// advisory lock for its run or group, so concurrent drainers take turns and never create two.
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";

import { checkRunPayload, commentMarker, renderComment } from "@intenzo/core";

import type { Db } from "../db/db.ts";
import { installations, outbox, repos, runGroups, runs } from "../db/schema.ts";
import type { GitHub } from "../github/api.ts";
import { reportModel } from "../report/model.ts";
import type { EffectExecutor } from "./drain.ts";

export interface GitHubEffectDeps {
  db: Db;
  /** A client acting as the App's installation. */
  github: (installationId: number) => GitHub;
  /** Where the report pages live: https://intenzo-cloud.vercel.app */
  reportBaseUrl: string;
  /** The public Blob store's URL for a path (evidence GIFs, §28); absent when it isn't set. */
  publicFile?: (path: string) => string | null;
}

export function githubExecutors(deps: GitHubEffectDeps): Record<string, EffectExecutor> {
  return { check_run: checkRunExecutor(deps), comment: commentExecutor(deps) };
}

/** Holds a transaction-long lock on `key`: other drainers wait for it (§16.4). */
const lock = (tx: Db, key: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);

const Id = z.object({ id: z.number() });
// docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference
const CheckRuns = z.object({
  check_runs: z.array(z.object({ id: z.number(), external_id: z.string().nullish() })),
});
// docs.github.com/en/rest/issues/comments#list-issue-comments
const Comments = z.array(
  z.object({
    id: z.number(),
    body: z.string().nullish(),
    user: z.object({ type: z.string() }).nullish(),
  }),
);

export const CHECK_NAME = "Intenzo";

/** §26.2: one check run per run, named Intenzo, with the run's id as its external_id. */
export function checkRunExecutor(deps: GitHubEffectDeps): EffectExecutor {
  return {
    run: (row) =>
      deps.db.transaction(async (tx) => {
        const runId = row.runId!;
        await lock(tx, `check:${runId}`);
        const [ctx] = await tx
          .select({ run: runs, repo: repos, installation: installations })
          .from(runs)
          .innerJoin(runGroups, eq(runs.runGroupId, runGroups.id))
          .innerJoin(repos, eq(runGroups.repoId, repos.id))
          .innerJoin(installations, eq(repos.installationId, installations.id))
          .where(eq(runs.id, runId));
        const { run, repo, installation } = ctx!;
        const github = deps.github(installation.ghInstallationId);
        const model = await reportModel(
          tx,
          run.runGroupId,
          deps.reportBaseUrl,
          runId,
          deps.publicFile,
        );
        const payload = checkRunPayload(model!);
        const fields = {
          status: payload.status,
          details_url: payload.detailsUrl,
          ...(payload.conclusion && { conclusion: payload.conclusion }),
          ...(run.startedAt && { started_at: run.startedAt.toISOString() }),
          ...(payload.status === "completed" && {
            completed_at: (run.finishedAt ?? new Date()).toISOString(),
          }),
          output: payload.output,
          actions: payload.actions,
        };

        // §16.4: a check run created by a drainer that died before saving its id is found by
        // its external_id, not created twice.
        let id = run.checkRunId;
        if (id === null) {
          const query = new URLSearchParams({
            check_name: CHECK_NAME,
            filter: "all",
            per_page: "100",
          });
          const listed = await github.get(
            `/repos/${repo.fullName}/commits/${run.headSha}/check-runs?${query}`,
            CheckRuns,
          );
          id = listed?.check_runs.find((c) => c.external_id === runId)?.id ?? null;
        }
        if (id === null) {
          const body = { name: CHECK_NAME, head_sha: run.headSha, external_id: runId, ...fields };
          id = required(
            await github.send("POST", `/repos/${repo.fullName}/check-runs`, body, Id),
          ).id;
        } else {
          await github.send("PATCH", `/repos/${repo.fullName}/check-runs/${id}`, fields, Id);
        }
        await tx.update(runs).set({ checkRunId: id }).where(eq(runs.id, runId));
        return String(id);
      }),
  };
}

/** §26.1: one comment per run group, edited in place from then on. */
export function commentExecutor(deps: GitHubEffectDeps): EffectExecutor {
  return {
    run: (row) =>
      deps.db.transaction(async (tx) => {
        const groupId = row.groupId!;
        await lock(tx, `comment:${groupId}`);
        // §16.4: a newer pending comment effect will show this state or a later one.
        const [newer] = await tx
          .select({ id: outbox.id })
          .from(outbox)
          .where(
            and(
              eq(outbox.groupId, groupId),
              eq(outbox.effect, "comment"),
              eq(outbox.status, "pending"),
              gt(outbox.id, row.id),
            ),
          )
          .limit(1);
        if (newer) return null;

        const [ctx] = await tx
          .select({ group: runGroups, repo: repos, installation: installations })
          .from(runGroups)
          .innerJoin(repos, eq(runGroups.repoId, repos.id))
          .innerJoin(installations, eq(repos.installationId, installations.id))
          .where(eq(runGroups.id, groupId));
        const { group, repo, installation } = ctx!;
        const github = deps.github(installation.ghInstallationId);
        const model = await reportModel(
          tx,
          groupId,
          deps.reportBaseUrl,
          undefined,
          deps.publicFile,
        );
        if (!model) return null; // a group without runs has nothing to say yet
        const body = renderComment(model);
        const comments = `/repos/${repo.fullName}/issues/${group.prNumber}/comments`;

        let id = group.commentId;
        if (id === null) {
          // A comment posted by a drainer that died before saving its id: found by its marker.
          const listed = await github.get(`${comments}?per_page=100`, Comments);
          const ours = listed?.find(
            (c) => c.user?.type === "Bot" && c.body?.startsWith(commentMarker(groupId)),
          );
          id = ours?.id ?? null;
        }
        if (id !== null) {
          const path = `/repos/${repo.fullName}/issues/comments/${id}`;
          // Someone deleted it: post a new one.
          if (!(await github.send("PATCH", path, { body }, Id))) id = null;
        }
        if (id === null) id = required(await github.send("POST", comments, { body }, Id)).id;
        await tx.update(runGroups).set({ commentId: id }).where(eq(runGroups.id, groupId));
        return String(id);
      }),
  };
}

function required<T>(answer: T | null): T {
  if (answer === null) throw new Error("GitHub answered 404: the repo or PR isn't reachable");
  return answer;
}
