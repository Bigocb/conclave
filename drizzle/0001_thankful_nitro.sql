CREATE TABLE "clv_fleet_config" (
	"org_id" text PRIMARY KEY NOT NULL,
	"server" text NOT NULL,
	"scope" text DEFAULT 'public' NOT NULL,
	"providers" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clv_fleet_reviewers" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"channels" text NOT NULL,
	"type" text DEFAULT 'llm' NOT NULL,
	"model" text,
	"provider" text,
	"llm_url" text,
	"llm_key" text,
	"command" text,
	"replicas" integer DEFAULT 1 NOT NULL,
	"mode" text DEFAULT 'auto' NOT NULL,
	"confidence_threshold" integer DEFAULT 8 NOT NULL,
	"prompt" text,
	"instructions" text,
	"skills" text,
	"steps" text,
	"interval" integer,
	"max_concurrent" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clv_fleet_config" ADD CONSTRAINT "clv_fleet_config_org_id_clv_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."clv_organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clv_fleet_reviewers" ADD CONSTRAINT "clv_fleet_reviewers_org_id_clv_fleet_config_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."clv_fleet_config"("org_id") ON DELETE no action ON UPDATE no action;