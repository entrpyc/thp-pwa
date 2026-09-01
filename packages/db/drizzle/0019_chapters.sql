ALTER TYPE "public"."pipeline_step" ADD VALUE 'generate_chapters';--> statement-breakpoint
CREATE TABLE "chapter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_id" uuid NOT NULL,
	"start_ms" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"generated_by" jsonb NOT NULL,
	"edited_by_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chapter_start_non_negative" CHECK ("chapter"."start_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "chapter" ADD CONSTRAINT "chapter_recording_id_recording_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recording"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chapter_recording_start_unique" ON "chapter" USING btree ("recording_id","start_ms");--> statement-breakpoint
CREATE INDEX "chapter_recording_start_idx" ON "chapter" USING btree ("recording_id","start_ms");