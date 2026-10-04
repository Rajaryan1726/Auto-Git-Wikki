ALTER TABLE "repositories" ADD COLUMN "github_pushed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "repos_synced_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "index_jobs_repo_created_idx" ON "index_jobs" USING btree ("repo_id","created_at");