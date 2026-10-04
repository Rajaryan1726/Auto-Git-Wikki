ALTER TABLE "chat_messages" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "commit_sha" text;--> statement-breakpoint
CREATE INDEX "chat_messages_thread_created_idx" ON "chat_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_threads_user_repo_updated_idx" ON "chat_threads" USING btree ("user_id","repo_id","updated_at");