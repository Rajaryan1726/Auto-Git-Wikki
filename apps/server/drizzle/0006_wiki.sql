CREATE TYPE "public"."wiki_run_status" AS ENUM('running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "wiki_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"index_job_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" "wiki_run_status" DEFAULT 'running' NOT NULL,
	"pages_total" integer,
	"pages_done" integer DEFAULT 0 NOT NULL,
	"outline" jsonb,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "wiki_pages" DROP CONSTRAINT "wiki_pages_job_slug_uq";--> statement-breakpoint
ALTER TABLE "index_jobs" ADD COLUMN "wiki_pages_total" integer;--> statement-breakpoint
ALTER TABLE "index_jobs" ADD COLUMN "wiki_pages_done" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "wiki_run_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "wiki_runs" ADD CONSTRAINT "wiki_runs_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_runs" ADD CONSTRAINT "wiki_runs_index_job_id_index_jobs_id_fk" FOREIGN KEY ("index_job_id") REFERENCES "public"."index_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wiki_runs_job_started_idx" ON "wiki_runs" USING btree ("index_job_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_runs_one_running_per_repo" ON "wiki_runs" USING btree ("repo_id") WHERE "wiki_runs"."status" = 'running';--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_wiki_run_id_wiki_runs_id_fk" FOREIGN KEY ("wiki_run_id") REFERENCES "public"."wiki_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_run_slug_uq" UNIQUE("wiki_run_id","slug");