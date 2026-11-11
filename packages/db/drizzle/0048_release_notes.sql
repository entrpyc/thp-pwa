CREATE TABLE "release_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_note_title_length" CHECK (char_length("release_note"."title") between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "announcement" ADD COLUMN "release_note_id" uuid;--> statement-breakpoint
ALTER TABLE "release_note" ADD CONSTRAINT "release_note_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "release_note_created_idx" ON "release_note" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_release_note_id_release_note_id_fk" FOREIGN KEY ("release_note_id") REFERENCES "public"."release_note"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_release_note_on_new_feature" CHECK ("announcement"."kind" = 'new_feature' or "announcement"."release_note_id" is null);