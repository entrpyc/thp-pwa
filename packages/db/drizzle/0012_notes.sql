CREATE TYPE "public"."note_visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TABLE "note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"parent_id" uuid,
	"timestamp_ms" integer,
	"visibility" "note_visibility" NOT NULL,
	"text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"is_reply" boolean GENERATED ALWAYS AS (parent_id is not null) STORED,
	"parent_is_reply" boolean GENERATED ALWAYS AS (case when parent_id is null then null else false end) STORED,
	CONSTRAINT "note_recording_id_unique" UNIQUE("recording_id","id"),
	CONSTRAINT "note_id_is_reply_unique" UNIQUE("id","is_reply"),
	CONSTRAINT "note_position_on_top_level_only" CHECK (("note"."parent_id" is null) = ("note"."timestamp_ms" is not null)),
	CONSTRAINT "note_reply_is_public" CHECK ("note"."parent_id" is null or "note"."visibility" = 'public'),
	CONSTRAINT "note_text_length" CHECK (char_length("note"."text") <= 1000),
	CONSTRAINT "note_tombstone_has_no_text" CHECK (("note"."text" is null) = ("note"."deleted_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_recording_id_recording_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recording"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_parent_top_level_fk" FOREIGN KEY ("parent_id","parent_is_reply") REFERENCES "public"."note"("id","is_reply") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_recording_timestamp_idx" ON "note" USING btree ("recording_id","timestamp_ms","created_at");--> statement-breakpoint
CREATE INDEX "note_parent_created_idx" ON "note" USING btree ("parent_id","created_at");