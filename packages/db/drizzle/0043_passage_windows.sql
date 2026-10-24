ALTER TYPE "public"."embedding_source" ADD VALUE 'recording';--> statement-breakpoint
ALTER TABLE "embedding" ADD COLUMN "window_first_segment_id" uuid;--> statement-breakpoint
ALTER TABLE "embedding" ADD COLUMN "window_last_segment_id" uuid;--> statement-breakpoint
ALTER TABLE "segment" ADD COLUMN "paragraph_index" integer;--> statement-breakpoint
ALTER TABLE "embedding" ADD CONSTRAINT "embedding_window_only_on_segment" CHECK (("embedding"."window_first_segment_id" is null and "embedding"."window_last_segment_id" is null) or "embedding"."source_kind" = 'segment');
