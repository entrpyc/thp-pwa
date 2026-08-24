CREATE TABLE "note_pin" (
	"note_id" uuid PRIMARY KEY NOT NULL,
	"recording_id" uuid NOT NULL,
	"pinned_by" uuid,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note_reaction" (
	"note_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"reacted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_reaction_note_id_user_id_pk" PRIMARY KEY("note_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "note_pin" ADD CONSTRAINT "note_pin_pinned_by_user_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_pin" ADD CONSTRAINT "note_pin_note_fk" FOREIGN KEY ("recording_id","note_id") REFERENCES "public"."note"("recording_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_reaction" ADD CONSTRAINT "note_reaction_note_id_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_reaction" ADD CONSTRAINT "note_reaction_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_pin_recording_idx" ON "note_pin" USING btree ("recording_id");