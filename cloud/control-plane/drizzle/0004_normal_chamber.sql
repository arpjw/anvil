ALTER TABLE "sessions" ADD COLUMN "checkpoint_phase" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "checkpoint_state" jsonb;