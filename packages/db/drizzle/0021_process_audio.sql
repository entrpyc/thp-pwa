ALTER TYPE "public"."pipeline_step" ADD VALUE 'process_audio' BEFORE 'transcribe';--> statement-breakpoint
ALTER TABLE "recording" ADD COLUMN "playback_media_key" text;