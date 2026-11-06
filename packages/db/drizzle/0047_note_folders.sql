CREATE TABLE "note_folder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_folder_name_length" CHECK (char_length("note_folder"."name") between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "note_folder_note" (
	"folder_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_folder_note_folder_id_note_id_pk" PRIMARY KEY("folder_id","note_id")
);
--> statement-breakpoint
ALTER TABLE "note_folder" ADD CONSTRAINT "note_folder_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_folder_note" ADD CONSTRAINT "note_folder_note_folder_id_note_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."note_folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_folder_note" ADD CONSTRAINT "note_folder_note_note_id_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_folder_user_idx" ON "note_folder" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "note_folder_user_name_unique" ON "note_folder" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE INDEX "note_folder_note_note_idx" ON "note_folder_note" USING btree ("note_id");