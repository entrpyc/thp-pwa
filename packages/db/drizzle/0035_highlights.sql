CREATE TYPE "public"."highlight_kind" AS ENUM('recording', 'segment', 'note');--> statement-breakpoint
CREATE TABLE "highlight" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"recording_id" uuid NOT NULL,
	"kind" "highlight_kind" NOT NULL,
	"position_ms" integer,
	"segment_id" uuid,
	"note_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "highlight_shape" CHECK (("highlight"."kind" = 'segment') = ("highlight"."position_ms" is not null)
        and ("highlight"."kind" = 'note') = ("highlight"."note_id" is not null)
        and ("highlight"."segment_id" is null or "highlight"."kind" = 'segment')
        and ("highlight"."position_ms" is null or "highlight"."position_ms" >= 0))
);
--> statement-breakpoint
ALTER TABLE "highlight" ADD CONSTRAINT "highlight_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "highlight" ADD CONSTRAINT "highlight_recording_id_recording_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recording"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "highlight" ADD CONSTRAINT "highlight_segment_id_segment_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "highlight" ADD CONSTRAINT "highlight_note_recording_fk" FOREIGN KEY ("recording_id","note_id") REFERENCES "public"."note"("recording_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "highlight_user_created_idx" ON "highlight" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "highlight_recording_unique" ON "highlight" USING btree ("user_id","recording_id") WHERE "highlight"."kind" = 'recording';--> statement-breakpoint
CREATE UNIQUE INDEX "highlight_segment_unique" ON "highlight" USING btree ("user_id","recording_id","position_ms") WHERE "highlight"."kind" = 'segment';--> statement-breakpoint
CREATE UNIQUE INDEX "highlight_note_unique" ON "highlight" USING btree ("user_id","note_id") WHERE "highlight"."kind" = 'note';