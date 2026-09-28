ALTER TABLE "repositories" ADD COLUMN "agent_container" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "agent_image" text;