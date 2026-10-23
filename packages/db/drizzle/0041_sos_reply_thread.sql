ALTER TABLE "sos_reply" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "sos_reply" ADD CONSTRAINT "sos_reply_parent_id_sos_reply_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."sos_reply"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sos_reply_parent_created_idx" ON "sos_reply" USING btree ("parent_id","created_at");