ALTER TABLE "repos" ADD COLUMN "generated_rules" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "analyzed_at" timestamp with time zone;