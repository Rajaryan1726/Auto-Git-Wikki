ALTER TABLE "users" ADD COLUMN "github_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "github_refresh_token_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "github_refresh_token_expires_at" timestamp with time zone;