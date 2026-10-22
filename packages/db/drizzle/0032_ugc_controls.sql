CREATE TYPE "public"."report_outcome" AS ENUM('dismissed', 'removed');--> statement-breakpoint
CREATE TYPE "public"."report_reason" AS ENUM('harassment', 'hateful', 'sexual', 'spam', 'other');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'note_reported' BEFORE 'announcement';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'report_resolved' BEFORE 'announcement';--> statement-breakpoint
CREATE TABLE "note_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"reporter_id" uuid,
	"reason" "report_reason" NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"outcome" "report_outcome",
	"resolved_by" uuid,
	CONSTRAINT "note_report_resolution_whole" CHECK (("note_report"."resolved_at" is null) = ("note_report"."outcome" is null)),
	CONSTRAINT "note_report_detail_length" CHECK (char_length("note_report"."detail") <= 500)
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "terms_accepted_version" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "note_report" ADD CONSTRAINT "note_report_note_id_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_report" ADD CONSTRAINT "note_report_reporter_id_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_report" ADD CONSTRAINT "note_report_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_report_open_idx" ON "note_report" USING btree ("created_at") WHERE "note_report"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "note_report_note_idx" ON "note_report" USING btree ("note_id");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_terms_acceptance_whole" CHECK (("user"."terms_accepted_version" is null) = ("user"."terms_accepted_at" is null));