CREATE TABLE "index_chunks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "index_chunks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_id" uuid NOT NULL,
	"point_id" uuid NOT NULL,
	"file_path" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"language" text NOT NULL,
	"symbol" text,
	"chunk_type" text NOT NULL,
	"text" text NOT NULL,
	"embedded_at" timestamp with time zone,
	CONSTRAINT "index_chunks_job_point_uq" UNIQUE("job_id","point_id")
);
--> statement-breakpoint
ALTER TABLE "index_jobs" ADD COLUMN "embedding_dims" integer DEFAULT 768 NOT NULL;--> statement-breakpoint
ALTER TABLE "index_jobs" ADD COLUMN "chunks_total" integer;--> statement-breakpoint
ALTER TABLE "index_jobs" ADD COLUMN "embedded_chunks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "index_jobs" ADD COLUMN "stats" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "index_chunks" ADD CONSTRAINT "index_chunks_job_id_index_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."index_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "index_chunks_job_pending_idx" ON "index_chunks" USING btree ("job_id","embedded_at");--> statement-breakpoint
-- Phase 3A jobs finished without embeddings: they must not count as indexed.
UPDATE "repositories" SET "last_indexed_job_id" = NULL
WHERE "last_indexed_job_id" IN (SELECT "id" FROM "index_jobs" WHERE "status" = 'done' AND "chunks_total" IS NULL);--> statement-breakpoint
UPDATE "index_jobs" SET "error" = 'Indexed before embeddings existed (no vectors). Re-index to enable search and chat.'
WHERE "status" = 'done' AND "chunks_total" IS NULL;
