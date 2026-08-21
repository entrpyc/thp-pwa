CREATE TABLE "segment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transcript_id" uuid NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"text" text NOT NULL,
	"corrected_at" timestamp with time zone,
	"corrected_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "transcript" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_id" uuid NOT NULL,
	"language" text NOT NULL,
	"confidence" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_confidence_range" CHECK ("transcript"."confidence" between 0 and 1)
);
--> statement-breakpoint
ALTER TABLE "segment" ADD CONSTRAINT "segment_transcript_id_transcript_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcript"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment" ADD CONSTRAINT "segment_corrected_by_user_id_user_id_fk" FOREIGN KEY ("corrected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript" ADD CONSTRAINT "transcript_recording_id_recording_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recording"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "segment_transcript_start_idx" ON "segment" USING btree ("transcript_id","start_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_recording_unique" ON "transcript" USING btree ("recording_id");