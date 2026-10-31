// The Cloud's Postgres tables (§11), in Drizzle. `pnpm db:generate` writes each change as a SQL
// migration in apps/cloud/drizzle/, and `pnpm db:migrate` applies them.
import type { ReasonCode, RunOutcome, VerdictValue } from "@intenzo/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import type { OutcomeReason, RunState, RunTrigger } from "../runs/transition.ts";

const id = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const at = (name: string) => timestamp(name, { withTimezone: true });
/** GitHub ids (installations, repos, deployments, comments, check runs) stay well below 2^53. */
const githubId = (name: string) => bigint(name, { mode: "number" });
const usd = (name: string) => numeric(name, { precision: 10, scale: 4, mode: "number" });

/**
 * Each webhook delivery Intenzo acts on, stored once (§11, §17). GitHub redelivers after a timeout
 * or when someone presses "Redeliver", so `delivery_id` (the X-GitHub-Delivery GUID) is unique and
 * a redelivery is answered without being dispatched again.
 */
export const webhookEvents = pgTable("webhook_events", {
  id: id(),
  deliveryId: text("delivery_id").notNull().unique(),
  event: text("event").notNull(),
  action: text("action"),
  /** The body as GitHub sent it. Postgres parses it, so 64-bit ids keep every digit (T0.4). */
  payloadJson: jsonb("payload_json").notNull(),
  receivedAt: at("received_at").notNull(),
  /** Set when dispatch finished. Null with `error` set: dispatch failed. */
  processedAt: at("processed_at"),
  error: text("error"),
});

export const installations = pgTable("installations", {
  id: id(),
  ghInstallationId: githubId("gh_installation_id").notNull().unique(),
  account: text("account").notNull(),
  createdAt: at("created_at").notNull().defaultNow(),
});

export const repos = pgTable("repos", {
  id: id(),
  installationId: bigint("installation_id", { mode: "number" })
    .notNull()
    .references(() => installations.id),
  ghRepoId: githubId("gh_repo_id").notNull().unique(),
  fullName: text("full_name").notNull(),
  defaultBranch: text("default_branch").notNull(),
  /** The validated .intenzo.yml (§10); null until it has been read. */
  configJson: jsonb("config_json"),
  /** A second line of defence against production URLs (§17.3, §29). */
  prodDomains: text("prod_domains")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  /** Encrypted (§29): the test-hook secret, the test users, the protection-bypass token. */
  hookSecretEnc: text("hook_secret_enc"),
  usersEnc: text("users_enc"),
  bypassEnc: text("bypass_enc"),
  enabled: boolean("enabled").notNull().default(true),
});

/** Every deployment_status Intenzo hears about, by commit: runs look their preview up here (§16.2). */
export const deployments = pgTable(
  "deployments",
  {
    id: id(),
    repoId: bigint("repo_id", { mode: "number" })
      .notNull()
      .references(() => repos.id),
    sha: text("sha").notNull(),
    /** As GitHub names it: Vercel's are exactly `Preview` and `Production` (T0.4). */
    environment: text("environment").notNull(),
    url: text("url"),
    /** The latest deployment_status state: success, failure, error… */
    state: text("state").notNull(),
    ghDeploymentId: githubId("gh_deployment_id").notNull(),
    receivedAt: at("received_at").notNull(),
  },
  (t) => [unique().on(t.repoId, t.sha, t.environment)],
);

export type RunGroupState = "open" | "merged" | "closed";

/** One per pull request: its runs, its one comment, and its agent and billing counters (§16.3). */
export const runGroups = pgTable(
  "run_groups",
  {
    id: id(),
    repoId: bigint("repo_id", { mode: "number" })
      .notNull()
      .references(() => repos.id),
    prNumber: integer("pr_number").notNull(),
    /** The PR's ticket (§17.2), from its context bundle: "#5" and its title, for the comment. */
    ticketRef: text("ticket_ref"),
    ticketTitle: text("ticket_title"),
    state: text("state").$type<RunGroupState>().notNull().default("open"),
    commentId: githubId("comment_id"),
    agentAttempts: integer("agent_attempts").notNull().default(0),
    billedAt: at("billed_at"),
    judgedRuns: integer("judged_runs").notNull().default(0),
    /**
     * §29: a fork's PR never gets the repo's secrets. Set from each pull_request event; until one
     * says otherwise, a PR counts as a fork.
     */
    fromFork: boolean("from_fork").notNull().default(true),
  },
  (t) => [
    unique().on(t.repoId, t.prNumber),
    check("run_groups_state", sql`${t.state} in ('open', 'merged', 'closed')`),
  ],
);

/** The criteria read from one version of the ticket, reused while the ticket doesn't change. */
export const intentVersions = pgTable(
  "intent_versions",
  {
    id: id(),
    runGroupId: bigint("run_group_id", { mode: "number" })
      .notNull()
      .references(() => runGroups.id),
    ticketHash: text("ticket_hash").notNull(),
    intentJson: jsonb("intent_json").notNull(),
  },
  (t) => [unique().on(t.runGroupId, t.ticketHash)],
);

/** One verification of one commit (§16.1). transition.ts decides every change to it. */
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runGroupId: bigint("run_group_id", { mode: "number" })
      .notNull()
      .references(() => runGroups.id),
    headSha: text("head_sha").notNull(),
    /** Counts from 1 per head SHA (§16.3). */
    attemptNo: integer("attempt_no").notNull(),
    trigger: text("trigger").$type<RunTrigger>().notNull(),
    state: text("state").$type<RunState>().notNull(),
    outcome: text("outcome").$type<RunOutcome>(),
    /** Why a run ended without verdicts: preview_not_ready, preview_failed, deadline_passed. */
    outcomeReason: text("outcome_reason").$type<OutcomeReason>(),
    prUrl: text("pr_url"),
    /** The baseline (§17.3): a preview of the base branch, at the merge base or before it. */
    baseUrl: text("base_url"),
    baseSha: text("base_sha"),
    /**
     * Commits between the merge base and base_sha: 0 is the merge base itself. With drift, the
     * report says so and unrequested-change detection is skipped (§24).
     */
    baseDrift: integer("base_drift"),
    intentVersionId: bigint("intent_version_id", { mode: "number" }).references(
      () => intentVersions.id,
    ),
    coverageJson: jsonb("coverage_json"),
    currentJobId: uuid("current_job_id"),
    modalCallId: text("modal_call_id"),
    checkRunId: githubId("check_run_id"),
    /** Orders runs within a group (§16.3) and times the wait for a preview (§16.1). */
    createdAt: at("created_at").notNull(),
    startedAt: at("started_at"),
    deadlineAt: at("deadline_at"),
    finishedAt: at("finished_at"),
    costUsd: usd("cost_usd"),
    timingsJson: jsonb("timings_json"),
  },
  (t) => [
    unique().on(t.runGroupId, t.headSha, t.attemptNo),
    check("runs_state", sql`${t.state} in ('waiting_inputs', 'verifying', 'reporting', 'done')`),
    // §16.1: the outcome is set exactly when the run is done.
    check("runs_outcome_when_done", sql`(${t.state} = 'done') = (${t.outcome} is not null)`),
  ],
);

/**
 * Every event a worker reported for a run's current job (§9), stored once: `(job_id, seq)` is unique,
 * so a retried POST is ignored. Events from a job that isn't current are answered 410, not stored.
 */
export const jobEvents = pgTable(
  "job_events",
  {
    id: id(),
    jobId: uuid("job_id").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    receivedAt: at("received_at").notNull(),
  },
  (t) => [unique().on(t.jobId, t.seq)],
);

export const criteriaResults = pgTable(
  "criteria_results",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    criterionId: text("criterion_id").notNull(),
    verdict: text("verdict").$type<VerdictValue>().notNull(),
    reasonCode: text("reason_code").$type<ReasonCode>().notNull(),
    evidenceJson: jsonb("evidence_json"),
    lanesJson: jsonb("lanes_json"),
    judgesJson: jsonb("judges_json"),
  },
  (t) => [unique().on(t.runId, t.criterionId)],
);

/** Navigator paths that reached a criterion, replayed by later runs of the same group (§20). */
export const savedPaths = pgTable(
  "saved_paths",
  {
    id: id(),
    runGroupId: bigint("run_group_id", { mode: "number" })
      .notNull()
      .references(() => runGroups.id),
    criterionId: text("criterion_id").notNull(),
    intentVersionId: bigint("intent_version_id", { mode: "number" })
      .notNull()
      .references(() => intentVersions.id),
    pathJson: jsonb("path_json").notNull(),
  },
  (t) => [unique().on(t.runGroupId, t.criterionId, t.intentVersionId)],
);

export type OutboxStatus = "pending" | "in_flight" | "done" | "failed";

/** Every GitHub write and job spawn, written in the same transaction as the run change (§16.4). */
export const outbox = pgTable(
  "outbox",
  {
    id: id(),
    runId: uuid("run_id").references(() => runs.id),
    groupId: bigint("group_id", { mode: "number" }).references(() => runGroups.id),
    effect: text("effect").notNull(),
    idemKey: text("idem_key").notNull().unique(),
    payloadJson: jsonb("payload_json").notNull(),
    status: text("status").$type<OutboxStatus>().notNull().default("pending"),
    leaseUntil: at("lease_until"),
    attempts: integer("attempts").notNull().default(0),
    externalId: text("external_id"),
    lastError: text("last_error"),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [check("outbox_status", sql`${t.status} in ('pending', 'in_flight', 'done', 'failed')`)],
);

/** One row per model call: cost and latency per run (§30) and the bench charts. */
export const modelCalls = pgTable("model_calls", {
  id: id(),
  /** Null for calls outside a run (IntentBench). */
  runId: uuid("run_id").references(() => runs.id),
  stage: text("stage").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version"),
  latencyMs: integer("latency_ms"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  videoS: doublePrecision("video_s"),
  frames: integer("frames"),
  costUsd: usd("cost_usd"),
  cacheHit: boolean("cache_hit").notNull().default(false),
  error: text("error"),
  createdAt: at("created_at").notNull().defaultNow(),
});
