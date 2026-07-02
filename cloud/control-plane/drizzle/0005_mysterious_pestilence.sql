CREATE TABLE IF NOT EXISTS "repo_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"index_version" text NOT NULL,
	"chunk_count" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"storage_path" text,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_embeddings_repo_id_unique" UNIQUE("repo_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "repo_embeddings" ADD CONSTRAINT "repo_embeddings_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
