CREATE TABLE "sync_receipt" (
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"code" text,
	"message" text,
	"note_id" uuid,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_receipt_user_id_client_id_pk" PRIMARY KEY("user_id","client_id"),
	CONSTRAINT "sync_receipt_kind" CHECK ("sync_receipt"."kind" in ('progress', 'note')),
	CONSTRAINT "sync_receipt_status" CHECK ("sync_receipt"."status" in ('applied', 'refused')),
	CONSTRAINT "sync_receipt_refusal_whole" CHECK (("sync_receipt"."status" = 'refused') = ("sync_receipt"."code" is not null))
);
--> statement-breakpoint
ALTER TABLE "sync_receipt" ADD CONSTRAINT "sync_receipt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_receipt" ADD CONSTRAINT "sync_receipt_note_id_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id") ON DELETE set null ON UPDATE no action;