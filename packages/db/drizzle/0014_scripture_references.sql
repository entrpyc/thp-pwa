CREATE TYPE "public"."scripture_origin" AS ENUM('machine', 'person');--> statement-breakpoint
ALTER TYPE "public"."review_kind" ADD VALUE 'scripture';--> statement-breakpoint
CREATE TABLE "scripture_reference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_id" uuid NOT NULL,
	"book" text NOT NULL,
	"chapter" integer NOT NULL,
	"verse_start" integer NOT NULL,
	"verse_end" integer NOT NULL,
	"origin" "scripture_origin" NOT NULL,
	"edited_by_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scripture_reference" ADD CONSTRAINT "scripture_reference_recording_id_recording_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recording"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scripture_reference_passage_unique" ON "scripture_reference" USING btree ("recording_id","book","chapter","verse_start","verse_end");--> statement-breakpoint
CREATE INDEX "scripture_reference_recording_idx" ON "scripture_reference" USING btree ("recording_id");