ALTER TABLE "chat_messages" ADD COLUMN "memory_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "memory_enabled" boolean DEFAULT true NOT NULL;