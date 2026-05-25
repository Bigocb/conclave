CREATE TABLE "clv_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"model" text,
	"provider" text,
	"llm_url" text,
	"instructions" text,
	"skills" text,
	"type" text,
	"command" text,
	"token" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text,
	CONSTRAINT "clv_agents_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "clv_attention_budgets" (
	"principal_id" text PRIMARY KEY NOT NULL,
	"earned" integer DEFAULT 15 NOT NULL,
	"spent" integer DEFAULT 0 NOT NULL,
	"earn_rate" integer DEFAULT 5 NOT NULL,
	"last_earn_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clv_budget_history" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"action" text NOT NULL,
	"amount" integer NOT NULL,
	"related_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clv_channel_subscriptions" (
	"principal_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"subscribed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clv_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"default_dimensions" text,
	"created_by_org" text,
	"created_at" text NOT NULL,
	CONSTRAINT "clv_channels_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "clv_opinion_responses" (
	"id" text PRIMARY KEY NOT NULL,
	"opinion_id" text NOT NULL,
	"respondent_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"response" text NOT NULL,
	"confidence" double precision NOT NULL,
	"reasoning" text,
	"references" text,
	"metadata" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clv_opinions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"question" text NOT NULL,
	"context" text,
	"channel" text NOT NULL,
	"requested_opinions" integer DEFAULT 3 NOT NULL,
	"deadline" text,
	"metadata" text,
	"budget_spent" integer DEFAULT 3 NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clv_org_members" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clv_organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"policies" text,
	"created_at" text NOT NULL,
	"updated_at" text,
	CONSTRAINT "clv_organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "clv_principals" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"roles" text,
	"capabilities" text,
	"metadata" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text
);
--> statement-breakpoint
CREATE TABLE "clv_reputation_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"performer_overall" double precision,
	"performer_dimensions" text,
	"performer_by_role" text,
	"reviewer_overall" double precision,
	"reviewer_alignment" double precision,
	"reviewer_helpfulness" double precision,
	"review_count" integer DEFAULT 0 NOT NULL,
	"task_count" integer DEFAULT 0 NOT NULL,
	"confidence" double precision DEFAULT 0 NOT NULL,
	"trend" text,
	"snapshot_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clv_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"scores" text NOT NULL,
	"weighted_overall" double precision NOT NULL,
	"reviewer_confidence" double precision NOT NULL,
	"comment" text NOT NULL,
	"suggestions" text,
	"approved" integer DEFAULT 0 NOT NULL,
	"helpful" integer,
	"status" text DEFAULT 'submitted' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text
);
--> statement-breakpoint
CREATE TABLE "clv_spot_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"review_id" text NOT NULL,
	"admin_id" text NOT NULL,
	"accuracy" integer NOT NULL,
	"fairness" integer NOT NULL,
	"comment" text,
	"dimensions_override" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clv_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"description" text NOT NULL,
	"dimensions" text NOT NULL,
	"output" text NOT NULL,
	"output_format" text DEFAULT 'markdown',
	"channel" text NOT NULL,
	"requested_reviews" integer DEFAULT 3 NOT NULL,
	"deadline" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"metadata" text,
	"budget_spent" integer DEFAULT 5 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text
);
--> statement-breakpoint
CREATE TABLE "clv_users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"full_name" text,
	"avatar_url" text,
	"google_id" text,
	"created_at" text NOT NULL,
	"updated_at" text,
	CONSTRAINT "clv_users_email_unique" UNIQUE("email"),
	CONSTRAINT "clv_users_google_id_unique" UNIQUE("google_id")
);
--> statement-breakpoint
ALTER TABLE "clv_agents" ADD CONSTRAINT "clv_agents_principal_id_clv_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."clv_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_agents" ADD CONSTRAINT "clv_agents_org_id_clv_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."clv_organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_attention_budgets" ADD CONSTRAINT "clv_attention_budgets_principal_id_clv_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."clv_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_budget_history" ADD CONSTRAINT "clv_budget_history_principal_id_clv_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."clv_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_channel_subscriptions" ADD CONSTRAINT "clv_channel_subscriptions_principal_id_clv_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."clv_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_channel_subscriptions" ADD CONSTRAINT "clv_channel_subscriptions_channel_id_clv_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."clv_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_channels" ADD CONSTRAINT "clv_channels_created_by_org_clv_organizations_id_fk" FOREIGN KEY ("created_by_org") REFERENCES "public"."clv_organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_opinion_responses" ADD CONSTRAINT "clv_opinion_responses_opinion_id_clv_opinions_id_fk" FOREIGN KEY ("opinion_id") REFERENCES "public"."clv_opinions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_opinion_responses" ADD CONSTRAINT "clv_opinion_responses_respondent_id_clv_agents_id_fk" FOREIGN KEY ("respondent_id") REFERENCES "public"."clv_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_opinion_responses" ADD CONSTRAINT "clv_opinion_responses_principal_id_clv_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."clv_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_opinions" ADD CONSTRAINT "clv_opinions_agent_id_clv_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."clv_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_opinions" ADD CONSTRAINT "clv_opinions_principal_id_clv_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."clv_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_org_members" ADD CONSTRAINT "clv_org_members_org_id_clv_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."clv_organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_org_members" ADD CONSTRAINT "clv_org_members_user_id_clv_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."clv_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_organizations" ADD CONSTRAINT "clv_organizations_owner_id_clv_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."clv_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_principals" ADD CONSTRAINT "clv_principals_org_id_clv_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."clv_organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_reputation_snapshots" ADD CONSTRAINT "clv_reputation_snapshots_principal_id_clv_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."clv_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_reviews" ADD CONSTRAINT "clv_reviews_task_id_clv_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."clv_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_reviews" ADD CONSTRAINT "clv_reviews_reviewer_id_clv_agents_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."clv_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_reviews" ADD CONSTRAINT "clv_reviews_principal_id_clv_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."clv_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_spot_checks" ADD CONSTRAINT "clv_spot_checks_review_id_clv_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."clv_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_tasks" ADD CONSTRAINT "clv_tasks_agent_id_clv_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."clv_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_tasks" ADD CONSTRAINT "clv_tasks_principal_id_clv_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."clv_principals"("id") ON DELETE no action ON UPDATE no action;