ALTER TABLE "execution_usage" ALTER COLUMN "cost_usd" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "max_budget_usd" numeric(12, 6);