ALTER TABLE "sos_signal" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sos_signal" ADD COLUMN "removed_by" uuid;--> statement-breakpoint
ALTER TABLE "sos_signal" ADD CONSTRAINT "sos_signal_removed_by_user_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "note_report_open_per_reporter_unique" ON "note_report" USING btree ("note_id","reporter_id") WHERE "note_report"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sos_report_open_signal_per_reporter_unique" ON "sos_report" USING btree ("signal_id","reporter_id") WHERE "sos_report"."resolved_at" is null and "sos_report"."about_reply" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "sos_report_open_reply_per_reporter_unique" ON "sos_report" USING btree ("reply_id","reporter_id") WHERE "sos_report"."resolved_at" is null and "sos_report"."reply_id" is not null;