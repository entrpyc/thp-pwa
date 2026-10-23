CREATE TABLE "note_image" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"media_key" text NOT NULL,
	"alt" text,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_image_alt_length" CHECK ("note_image"."alt" is null or char_length("note_image"."alt") between 1 and 200),
	CONSTRAINT "note_image_position_range" CHECK ("note_image"."position" >= 0 and "note_image"."position" < 3)
);
--> statement-breakpoint
ALTER TABLE "note_image" ADD CONSTRAINT "note_image_note_id_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_image_note_position_idx" ON "note_image" USING btree ("note_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "note_image_media_key_unique" ON "note_image" USING btree ("media_key");