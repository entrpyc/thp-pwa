CREATE TYPE "public"."sos_urgency" AS ENUM('red', 'orange', 'yellow', 'green');--> statement-breakpoint
ALTER TYPE "public"."notification_category" ADD VALUE 'sos';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'sos_raised' BEFORE 'announcement';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'sos_reply' BEFORE 'announcement';--> statement-breakpoint
CREATE TABLE "sos_praying" (
	"signal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"prayed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sos_praying_signal_id_user_id_pk" PRIMARY KEY("signal_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "sos_reply" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sos_reply_text_length" CHECK (char_length("sos_reply"."text") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "sos_signal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid NOT NULL,
	"urgency" "sos_urgency" NOT NULL,
	"description" text NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"closing_note" text,
	CONSTRAINT "sos_signal_description_length" CHECK (char_length("sos_signal"."description") between 1 and 500),
	CONSTRAINT "sos_signal_closing_note_length" CHECK ("sos_signal"."closing_note" is null or char_length("sos_signal"."closing_note") between 1 and 500),
	CONSTRAINT "sos_signal_note_when_closed" CHECK ("sos_signal"."closing_note" is null or "sos_signal"."closed_at" is not null),
	CONSTRAINT "sos_signal_closer_when_closed" CHECK ("sos_signal"."closed_by" is null or "sos_signal"."closed_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "sos_signal_id" uuid;--> statement-breakpoint
ALTER TABLE "sos_praying" ADD CONSTRAINT "sos_praying_signal_id_sos_signal_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."sos_signal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_praying" ADD CONSTRAINT "sos_praying_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_reply" ADD CONSTRAINT "sos_reply_signal_id_sos_signal_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."sos_signal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_reply" ADD CONSTRAINT "sos_reply_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_signal" ADD CONSTRAINT "sos_signal_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_signal" ADD CONSTRAINT "sos_signal_closed_by_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sos_reply_signal_created_idx" ON "sos_reply" USING btree ("signal_id","created_at");--> statement-breakpoint
CREATE INDEX "sos_signal_board_idx" ON "sos_signal" USING btree ("closed_at","urgency","raised_at");--> statement-breakpoint
CREATE INDEX "sos_signal_author_open_idx" ON "sos_signal" USING btree ("author_id") WHERE "sos_signal"."closed_at" is null;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_sos_signal_id_sos_signal_id_fk" FOREIGN KEY ("sos_signal_id") REFERENCES "public"."sos_signal"("id") ON DELETE cascade ON UPDATE no action;