ALTER TYPE "public"."notification_kind" ADD VALUE 'sos_reported' BEFORE 'announcement';--> statement-breakpoint
CREATE TABLE "sos_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"about_reply" boolean DEFAULT false NOT NULL,
	"reply_id" uuid,
	"reporter_id" uuid,
	"reason" "report_reason" NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"outcome" "report_outcome",
	"resolved_by" uuid,
	CONSTRAINT "sos_report_reply_only_when_about_reply" CHECK ("sos_report"."about_reply" or "sos_report"."reply_id" is null),
	CONSTRAINT "sos_report_resolution_whole" CHECK (("sos_report"."resolved_at" is null) = ("sos_report"."outcome" is null)),
	CONSTRAINT "sos_report_detail_length" CHECK (char_length("sos_report"."detail") <= 500)
);
--> statement-breakpoint
ALTER TABLE "sos_report" ADD CONSTRAINT "sos_report_signal_id_sos_signal_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."sos_signal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_report" ADD CONSTRAINT "sos_report_reply_id_sos_reply_id_fk" FOREIGN KEY ("reply_id") REFERENCES "public"."sos_reply"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_report" ADD CONSTRAINT "sos_report_reporter_id_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_report" ADD CONSTRAINT "sos_report_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sos_report_open_idx" ON "sos_report" USING btree ("created_at") WHERE "sos_report"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "sos_report_signal_idx" ON "sos_report" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX "sos_report_reply_idx" ON "sos_report" USING btree ("reply_id");--> statement-breakpoint
CREATE UNIQUE INDEX "series_artwork_key_unique" ON "series" USING btree ("artwork_key");--> statement-breakpoint
CREATE UNIQUE INDEX "user_avatar_key_unique" ON "user" USING btree ("avatar_key");