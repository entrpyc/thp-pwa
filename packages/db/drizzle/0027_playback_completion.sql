ALTER TABLE "playback_progress" ADD COLUMN "listened_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "playback_progress" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "playback_progress" ADD COLUMN "completed_at" timestamp with time zone;