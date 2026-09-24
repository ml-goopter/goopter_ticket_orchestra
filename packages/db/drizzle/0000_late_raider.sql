CREATE EXTENSION IF NOT EXISTS "citext";--> statement-breakpoint
CREATE TYPE "public"."actor_kind" AS ENUM('user', 'worker', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."author_kind" AS ENUM('agent', 'user');--> statement-breakpoint
CREATE TYPE "public"."ci_state" AS ENUM('pending', 'running', 'passed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."command_type" AS ENUM('start_spec_session', 'send_message', 'resume_with_decision', 'resume_with_revision', 'resume_with_ci_failure', 'cancel');--> statement-breakpoint
CREATE TYPE "public"."end_reason" AS ENUM('adapter_error', 'process_crash', 'lease_expired', 'agent_hung', 'setup_failed', 'protocol_violation', 'agent_gave_up', 'budget_exceeded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."execution_role" AS ENUM('spec', 'implementation');--> statement-breakpoint
CREATE TYPE "public"."execution_state" AS ENUM('QUEUED', 'ASSIGNED', 'RUNNING', 'WAITING_FOR_USER', 'COMPLETED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."issue_status" AS ENUM('OPEN', 'RESOLVED', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."issue_type" AS ENUM('QUESTION', 'DECISION_REQUIRED', 'BLOCKER', 'SPEC_AMBIGUITY', 'MISSING_INFORMATION', 'MISSING_ACCESS', 'UNEXPECTED_BEHAVIOR', 'SCOPE_CONFLICT', 'DEPENDENCY', 'RISK', 'VALIDATION_FAILURE');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('issue_raised', 'spec_review_requested', 'needs_human', 'ready_for_merge', 'execution_failed');--> statement-breakpoint
CREATE TYPE "public"."pr_state" AS ENUM('open', 'merged', 'closed');--> statement-breakpoint
CREATE TYPE "public"."resolution_kind" AS ENUM('clarification', 'spec_revision');--> statement-breakpoint
CREATE TYPE "public"."review_verdict" AS ENUM('clean', 'findings', 'ask_user');--> statement-breakpoint
CREATE TYPE "public"."revision_status" AS ENUM('draft', 'approved', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."runtime" AS ENUM('claude', 'codex');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('info', 'warning', 'blocking');--> statement-breakpoint
CREATE TYPE "public"."task_state" AS ENUM('NEEDS_SPEC', 'SPEC_IN_PROGRESS', 'SPEC_REVIEW', 'SPEC_APPROVED', 'READY', 'BLOCKED', 'IMPLEMENTING', 'REVIEWING', 'CI_RUNNING', 'READY_FOR_MERGE', 'NEEDS_HUMAN', 'DONE', 'CANCELLED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."usage_kind" AS ENUM('main', 'review', 'resume');--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"jira_jql" text NOT NULL,
	"max_infra_retries" integer DEFAULT 3 NOT NULL,
	"max_protocol_retries" integer DEFAULT 2 NOT NULL,
	"max_ci_rounds" integer DEFAULT 3 NOT NULL,
	"max_review_rounds" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"git_url" text NOT NULL,
	"default_branch" text NOT NULL,
	"default_runtime" "runtime" NOT NULL,
	"default_model" text,
	"max_concurrent_worktrees" integer DEFAULT 1 NOT NULL,
	"required_capability" text,
	"setup_command" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_project_id_name_unique" UNIQUE("project_id","name")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "specification_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"runtime" "runtime" NOT NULL,
	CONSTRAINT "specification_approvals_revision_id_unique" UNIQUE("revision_id")
);
--> statement-breakpoint
CREATE TABLE "specification_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "revision_status" NOT NULL,
	"content" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specification_revisions_task_id_version_key" UNIQUE("task_id","version")
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL,
	CONSTRAINT "task_dependencies_task_id_depends_on_task_id_pk" PRIMARY KEY("task_id","depends_on_task_id"),
	CONSTRAINT "task_dependencies_no_self_dependency" CHECK ("task_dependencies"."task_id" <> "task_dependencies"."depends_on_task_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_id" uuid,
	"jira_key" text NOT NULL,
	"jira_summary" text NOT NULL,
	"jira_priority" integer NOT NULL,
	"jira_created_at" timestamp with time zone NOT NULL,
	"jira_synced_at" timestamp with time zone NOT NULL,
	"state" "task_state" NOT NULL,
	"runtime_override" "runtime",
	"approved_revision_id" uuid,
	"needs_human_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_jira_key_unique" UNIQUE("jira_key")
);
--> statement-breakpoint
CREATE TABLE "agent_workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host" text NOT NULL,
	"capabilities" text[] NOT NULL,
	"max_concurrent" integer NOT NULL,
	"workspace_root" text NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_workers_host_unique" UNIQUE("host")
);
--> statement-breakpoint
CREATE TABLE "execution_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"execution_id" uuid,
	"type" "command_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "execution_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"kind" "usage_kind" NOT NULL,
	"round" integer,
	"runtime" "runtime" NOT NULL,
	"model" text NOT NULL,
	"input_tokens" bigint NOT NULL,
	"cached_input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cost_usd" numeric(12, 6) NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"role" "execution_role" NOT NULL,
	"attempt" integer NOT NULL,
	"state" "execution_state" NOT NULL,
	"runtime" "runtime" NOT NULL,
	"model" text NOT NULL,
	"spec_revision_id" uuid,
	"worker_id" uuid,
	"host" text,
	"worktree_path" text,
	"branch" text,
	"session_id" text,
	"end_reason" "end_reason",
	"end_detail" text,
	"review_rounds" integer DEFAULT 0 NOT NULL,
	"ci_rounds" integer DEFAULT 0 NOT NULL,
	"infra_retries_used" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"worktree_evicted_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "task_leases_task_id_unique" UNIQUE("task_id")
);
--> statement-breakpoint
CREATE TABLE "issue_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"author_kind" "author_kind" NOT NULL,
	"user_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"type" "issue_type" NOT NULL,
	"severity" "severity" NOT NULL,
	"blocking" boolean NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"question" text,
	"suggested_options" jsonb,
	"recommended_option" text,
	"status" "issue_status" NOT NULL,
	"resolution_kind" "resolution_kind",
	"resolution" text,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"clarification" text,
	"chosen_option" text,
	"decided_by" uuid NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_decisions_issue_id_unique" UNIQUE("issue_id")
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"url" text NOT NULL,
	"head_sha" text NOT NULL,
	"state" "pr_state" NOT NULL,
	"ci_state" "ci_state" NOT NULL,
	"ci_detail" jsonb,
	"last_polled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"merged_at" timestamp with time zone,
	CONSTRAINT "pull_requests_task_id_unique" UNIQUE("task_id")
);
--> statement-breakpoint
CREATE TABLE "review_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"verdict" "review_verdict" NOT NULL,
	"findings" jsonb NOT NULL,
	"reviewer_runtime" "runtime" NOT NULL,
	"usage_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"trigger" text NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"execution_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"task_id" uuid NOT NULL,
	"issue_id" uuid,
	"kind" "notification_kind" NOT NULL,
	"title" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specification_approvals" ADD CONSTRAINT "specification_approvals_revision_id_specification_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."specification_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specification_approvals" ADD CONSTRAINT "specification_approvals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specification_revisions" ADD CONSTRAINT "specification_revisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specification_revisions" ADD CONSTRAINT "specification_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_tasks_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_approved_revision_id_specification_revisions_id_fk" FOREIGN KEY ("approved_revision_id") REFERENCES "public"."specification_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_usage" ADD CONSTRAINT "execution_usage_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_spec_revision_id_specification_revisions_id_fk" FOREIGN KEY ("spec_revision_id") REFERENCES "public"."specification_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_worker_id_agent_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."agent_workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_leases" ADD CONSTRAINT "task_leases_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_leases" ADD CONSTRAINT "task_leases_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_leases" ADD CONSTRAINT "task_leases_worker_id_agent_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."agent_workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_messages" ADD CONSTRAINT "issue_messages_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_messages" ADD CONSTRAINT "issue_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_decisions" ADD CONSTRAINT "task_decisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_decisions" ADD CONSTRAINT "task_decisions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_decisions" ADD CONSTRAINT "task_decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_results" ADD CONSTRAINT "review_results_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_results" ADD CONSTRAINT "review_results_usage_id_execution_usage_id_fk" FOREIGN KEY ("usage_id") REFERENCES "public"."execution_usage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "specification_revisions_one_draft_per_task" ON "specification_revisions" USING btree ("task_id") WHERE "specification_revisions"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "specification_revisions_one_approved_per_task" ON "specification_revisions" USING btree ("task_id") WHERE "specification_revisions"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "tasks_state_idx" ON "tasks" USING btree ("state");--> statement-breakpoint
CREATE INDEX "tasks_repository_id_state_idx" ON "tasks" USING btree ("repository_id","state");--> statement-breakpoint
CREATE INDEX "execution_commands_unclaimed_idx" ON "execution_commands" USING btree ("claimed_at") WHERE "execution_commands"."claimed_at" is null;--> statement-breakpoint
CREATE INDEX "executions_task_id_created_at_idx" ON "executions" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "executions_state_host_idx" ON "executions" USING btree ("state","host");--> statement-breakpoint
CREATE INDEX "issues_status_created_at_idx" ON "issues" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "execution_events_task_id_id_idx" ON "execution_events" USING btree ("task_id","id");