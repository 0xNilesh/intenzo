CREATE TABLE "criteria_results" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "criteria_results_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" uuid NOT NULL,
	"criterion_id" text NOT NULL,
	"verdict" text NOT NULL,
	"reason_code" text NOT NULL,
	"evidence_json" jsonb,
	"lanes_json" jsonb,
	"judges_json" jsonb,
	CONSTRAINT "criteria_results_run_id_criterion_id_unique" UNIQUE("run_id","criterion_id")
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deployments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"repo_id" bigint NOT NULL,
	"sha" text NOT NULL,
	"environment" text NOT NULL,
	"url" text,
	"state" text NOT NULL,
	"gh_deployment_id" bigint NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "deployments_repo_id_sha_environment_unique" UNIQUE("repo_id","sha","environment")
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "installations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"gh_installation_id" bigint NOT NULL,
	"account" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installations_gh_installation_id_unique" UNIQUE("gh_installation_id")
);
--> statement-breakpoint
CREATE TABLE "intent_versions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "intent_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_group_id" bigint NOT NULL,
	"ticket_hash" text NOT NULL,
	"intent_json" jsonb NOT NULL,
	CONSTRAINT "intent_versions_run_group_id_ticket_hash_unique" UNIQUE("run_group_id","ticket_hash")
);
--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "model_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" uuid,
	"stage" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text,
	"latency_ms" integer,
	"tokens_in" integer,
	"tokens_out" integer,
	"video_s" double precision,
	"frames" integer,
	"cost_usd" numeric(10, 4),
	"cache_hit" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" uuid,
	"group_id" bigint,
	"effect" text NOT NULL,
	"idem_key" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"external_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_idem_key_unique" UNIQUE("idem_key"),
	CONSTRAINT "outbox_status" CHECK ("outbox"."status" in ('pending', 'in_flight', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "repos_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"installation_id" bigint NOT NULL,
	"gh_repo_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text NOT NULL,
	"config_json" jsonb,
	"prod_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"hook_secret_enc" text,
	"users_enc" text,
	"bypass_enc" text,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "repos_gh_repo_id_unique" UNIQUE("gh_repo_id")
);
--> statement-breakpoint
CREATE TABLE "run_groups" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "run_groups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"repo_id" bigint NOT NULL,
	"pr_number" integer NOT NULL,
	"ticket_ref" text,
	"state" text DEFAULT 'open' NOT NULL,
	"comment_id" bigint,
	"agent_attempts" integer DEFAULT 0 NOT NULL,
	"billed_at" timestamp with time zone,
	"judged_runs" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "run_groups_repo_id_pr_number_unique" UNIQUE("repo_id","pr_number"),
	CONSTRAINT "run_groups_state" CHECK ("run_groups"."state" in ('open', 'merged', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_group_id" bigint NOT NULL,
	"head_sha" text NOT NULL,
	"attempt_no" integer NOT NULL,
	"trigger" text NOT NULL,
	"state" text NOT NULL,
	"outcome" text,
	"outcome_reason" text,
	"pr_url" text,
	"base_url" text,
	"base_sha" text,
	"intent_version_id" bigint,
	"coverage_json" jsonb,
	"current_job_id" uuid,
	"modal_call_id" text,
	"check_run_id" bigint,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cost_usd" numeric(10, 4),
	"timings_json" jsonb,
	CONSTRAINT "runs_run_group_id_head_sha_attempt_no_unique" UNIQUE("run_group_id","head_sha","attempt_no"),
	CONSTRAINT "runs_state" CHECK ("runs"."state" in ('waiting_inputs', 'verifying', 'reporting', 'done')),
	CONSTRAINT "runs_outcome_when_done" CHECK (("runs"."state" = 'done') = ("runs"."outcome" is not null))
);
--> statement-breakpoint
CREATE TABLE "saved_paths" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "saved_paths_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_group_id" bigint NOT NULL,
	"criterion_id" text NOT NULL,
	"intent_version_id" bigint NOT NULL,
	"path_json" jsonb NOT NULL,
	CONSTRAINT "saved_paths_run_group_id_criterion_id_intent_version_id_unique" UNIQUE("run_group_id","criterion_id","intent_version_id")
);
--> statement-breakpoint
ALTER TABLE "criteria_results" ADD CONSTRAINT "criteria_results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent_versions" ADD CONSTRAINT "intent_versions_run_group_id_run_groups_id_fk" FOREIGN KEY ("run_group_id") REFERENCES "public"."run_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_group_id_run_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."run_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_groups" ADD CONSTRAINT "run_groups_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_run_group_id_run_groups_id_fk" FOREIGN KEY ("run_group_id") REFERENCES "public"."run_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_intent_version_id_intent_versions_id_fk" FOREIGN KEY ("intent_version_id") REFERENCES "public"."intent_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_paths" ADD CONSTRAINT "saved_paths_run_group_id_run_groups_id_fk" FOREIGN KEY ("run_group_id") REFERENCES "public"."run_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_paths" ADD CONSTRAINT "saved_paths_intent_version_id_intent_versions_id_fk" FOREIGN KEY ("intent_version_id") REFERENCES "public"."intent_versions"("id") ON DELETE no action ON UPDATE no action;