// What the Cloud does with pull_request and deployment_status events (§16.2, §17): record what
// happened, advance the run groups it concerns, then drain the outbox their decisions wrote to, so
// the check run and the comment change within seconds of the event (§16.4).
import { CONFIG_FILENAMES, configFromFiles, formatProblems } from "@intenzo/core";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../db/db.ts";
import {
  ensureRepo,
  ensureRunGroup,
  previewRules,
  type Repo,
  RepoPayload,
  repoConfig,
  saveConfig,
} from "../db/repos.ts";
import { runGroups, runs } from "../db/schema.ts";
import {
  deploymentUrl,
  FINAL_STATES,
  isPreviewEnvironment,
  previewUrl,
} from "../deployments/match.ts";
import { findPreview, recordDeployment } from "../deployments/store.ts";
import { advance } from "../runs/advance.ts";
import { describeBaseline, resolveBaseline } from "../runs/baseline.ts";
import type { Decision, Effect, Fact, Run } from "../runs/transition.ts";
import type { GitHub } from "./api.ts";
import type { EventHandler } from "./dispatch.ts";

export interface HandlerContext {
  db: Db;
  /** A client acting as the App's installation. */
  github: (installationId: number) => GitHub;
  now: () => Date;
  newRunId: () => string;
  /** One line per thing that happened. Never a payload, a token or a secret. */
  log: (line: string) => void;
  /** Runs the outbox's due effects (drainOutbox with the GitHub executors). */
  drain: () => Promise<unknown>;
}

export function eventHandlers(ctx: HandlerContext): Record<string, EventHandler> {
  return { pull_request: onPullRequest(ctx), deployment_status: onDeploymentStatus(ctx) };
}

const PullRequestEvent = z.looseObject({
  ...RepoPayload.shape,
  action: z.string(),
  number: z.number(),
  pull_request: z.looseObject({
    draft: z.boolean().optional(),
    // A fork's head repo is another repo, or null once the fork is deleted.
    head: z.looseObject({ sha: z.string(), repo: z.looseObject({ id: z.number() }).nullable() }),
    base: z.looseObject({ ref: z.string(), repo: z.looseObject({ id: z.number() }) }),
  }),
});
type PullRequestEvent = z.infer<typeof PullRequestEvent>;

/** The pull_request actions that start or replace a run (§17). Others change nothing yet. */
function pullRequestFact({
  action,
  pull_request: pr,
}: PullRequestEvent): Extract<Fact, { kind: "pr_ready" | "pr_pushed" }> | null {
  const draft = pr.draft ?? false;
  switch (action) {
    case "opened":
    case "reopened":
    case "ready_for_review":
      return { kind: "pr_ready", trigger: action, headSha: pr.head.sha, draft };
    case "synchronize":
      return { kind: "pr_pushed", headSha: pr.head.sha, draft };
    default:
      return null;
  }
}

function onPullRequest(ctx: HandlerContext): EventHandler {
  return async ({ payload }) => {
    const event = PullRequestEvent.parse(payload);
    const fact = pullRequestFact(event);
    if (!fact) return;
    const pr = { number: event.number, baseRef: event.pull_request.base.ref };
    const github = ctx.github(event.installation.id);
    let repo = await ensureRepo(ctx.db, event);

    // §10: the config on the default branch, so a PR can't change the rules it's verified under.
    const files = await Promise.all(
      CONFIG_FILENAMES.map(async (name) => ({
        name,
        text: await github.file(repo.fullName, name, repo.defaultBranch),
      })),
    );
    const { file, result } = configFromFiles(
      files.flatMap((f) => (f.text === null ? [] : [{ name: f.name, text: f.text }])),
    );
    if (!result.ok) {
      const problems = formatProblems(file ?? CONFIG_FILENAMES[0], result.problems);
      ctx.log(
        `PR #${pr.number}: not verified, the config has problems: ${problems.replaceAll("\n", "; ")}`,
      );
      return;
    }
    repo = await saveConfig(ctx.db, repo.id, result.config);

    const { head, base } = event.pull_request;
    const fromFork = head.repo?.id !== base.repo.id;
    const group = await ensureRunGroup(ctx.db, repo.id, pr.number, fromFork);
    // §16.2: a new run looks its preview up at once, through GitHub when none is stored.
    if (!fact.draft) await findPreview({ ...ctx, github }, repo, fact.headSha, previewRules(repo));
    const decision = await advance(ctx.db, group.id, fact, clock(ctx));
    await afterAdvance(ctx, github, repo, pr, decision);
  };
}

const DeploymentStatusEvent = z.looseObject({
  ...RepoPayload.shape,
  deployment_status: z.looseObject({
    state: z.string(),
    environment: z.string().optional(),
    environment_url: z.string().nullish(),
    target_url: z.string().nullish(),
  }),
  deployment: z.looseObject({ id: z.number(), sha: z.string(), environment: z.string() }),
});

// docs.github.com/en/rest/commits/commits#list-pull-requests-associated-with-a-commit
const Pulls = z.array(
  z.looseObject({
    number: z.number(),
    state: z.string(),
    head: z.looseObject({ sha: z.string() }),
    base: z.looseObject({ ref: z.string() }),
  }),
);

function onDeploymentStatus(ctx: HandlerContext): EventHandler {
  return async ({ payload }) => {
    const {
      deployment_status: status,
      deployment,
      ...event
    } = DeploymentStatusEvent.parse(payload);
    if (!FINAL_STATES.has(status.state)) return;
    const repo = await ensureRepo(ctx.db, event);
    const environment = status.environment ?? deployment.environment;
    const row = {
      repoId: repo.id,
      sha: deployment.sha,
      environment,
      url: deploymentUrl(status),
      state: status.state,
      ghDeploymentId: deployment.id,
      receivedAt: ctx.now(),
    };
    await recordDeployment(ctx.db, row);

    const what = `deployment of ${deployment.sha.slice(0, 7)} (${environment}, ${status.state})`;
    const rules = previewRules(repo);
    if (!isPreviewEnvironment(environment, rules.preview)) {
      return ctx.log(`${what}: stored; not a preview environment`);
    }
    let fact: Fact = { kind: "preview_failed", sha: deployment.sha };
    if (status.state === "success") {
      const url = previewUrl(row, rules);
      if (!url) return ctx.log(`${what}: stored; its URL can't be used`);
      fact = { kind: "preview_ready", sha: deployment.sha, url };
    }

    // §16.2: advance the open PRs whose head is this commit. A deployment never creates a run.
    const github = ctx.github(event.installation.id);
    const pulls = await github.get(
      `/repos/${repo.fullName}/commits/${deployment.sha}/pulls`,
      Pulls,
    );
    const heads = (pulls ?? []).filter((p) => p.state === "open" && p.head.sha === deployment.sha);
    if (heads.length === 0) return ctx.log(`${what}: stored; no open PR has it as its head`);
    for (const pull of heads) {
      const [group] = await ctx.db
        .select()
        .from(runGroups)
        .where(and(eq(runGroups.repoId, repo.id), eq(runGroups.prNumber, pull.number)));
      if (!group) continue;
      const decision = await advance(ctx.db, group.id, fact, clock(ctx));
      await afterAdvance(
        ctx,
        github,
        repo,
        { number: pull.number, baseRef: pull.base.ref },
        decision,
      );
    }
  };
}

const clock = (ctx: HandlerContext) => ({ now: ctx.now(), newRunId: ctx.newRunId });

/**
 * Logs what changed, gives each run that starts verifying its baseline (§17.3), then drains the
 * outbox, so the check run and the comment show the baseline too.
 */
async function afterAdvance(
  ctx: HandlerContext,
  github: GitHub,
  repo: Repo,
  pr: { number: number; baseRef: string },
  decision: Decision,
): Promise<void> {
  const changed = [...decision.created, ...decision.updated];
  for (const run of changed) ctx.log(`PR #${pr.number}: ${describeRun(run)}`);
  if (decision.effects.length > 0) {
    ctx.log(`PR #${pr.number}: effects: ${decision.effects.map(describeEffect).join(", ")}`);
  }

  for (const effect of decision.effects) {
    if (effect.kind !== "spawn_job") continue;
    const run = changed.find((r) => r.id === effect.runId)!;
    const prefix = `PR #${pr.number}: run ${run.id.slice(0, 8)}`;
    try {
      const config = repoConfig(repo);
      const baseline = await resolveBaseline(
        {
          github,
          findPreview: (sha) => findPreview({ ...ctx, github }, repo, sha, previewRules(repo)),
        },
        {
          repo: repo.fullName,
          baseRef: pr.baseRef,
          headSha: run.headSha,
          baseline: config.baseline,
        },
      );
      await ctx.db
        .update(runs)
        .set(
          baseline.url === null
            ? { baseUrl: null, baseSha: null, baseDrift: null }
            : { baseUrl: baseline.url, baseSha: baseline.sha, baseDrift: baseline.drift },
        )
        .where(eq(runs.id, run.id));
      const at = baseline.url === null ? "" : ` at ${baseline.url}`;
      ctx.log(`${prefix}: baseline ${describeBaseline(baseline, pr.baseRef)}${at}`);
    } catch (err) {
      // §17.3: without a baseline the run still verifies the PR, without before/after.
      const why = err instanceof Error ? err.message : String(err);
      ctx.log(`${prefix}: baseline lookup failed, going on without one: ${why}`);
    }
  }
  if (decision.effects.length > 0) await ctx.drain();
}

/** "run 8f9b1c2e (f3cbadc #1, opened): verifying https://…" */
function describeRun(run: Run): string {
  const head = `run ${run.id.slice(0, 8)} (${run.headSha.slice(0, 7)} #${run.attemptNo}, ${run.trigger})`;
  if (run.state === "done") {
    const reason = run.outcomeReason ? `, ${run.outcomeReason}` : "";
    return `${head}: done (${run.outcome}${reason})`;
  }
  return run.state === "verifying" ? `${head}: verifying ${run.prUrl}` : `${head}: ${run.state}`;
}

function describeEffect(effect: Effect): string {
  switch (effect.kind) {
    case "check_run":
      return `check ${effect.status}${effect.conclusion ? ` ${effect.conclusion}` : ""}`;
    case "comment":
      return "comment";
    case "spawn_job":
      return "spawn job";
    case "cancel_job":
      return "cancel job";
  }
}
