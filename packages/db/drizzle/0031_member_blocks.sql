CREATE TABLE "member_block" (
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_block_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id"),
	CONSTRAINT "member_block_not_self" CHECK ("member_block"."blocker_id" <> "member_block"."blocked_id")
);
--> statement-breakpoint
ALTER TABLE "member_block" ADD CONSTRAINT "member_block_blocker_id_user_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_block" ADD CONSTRAINT "member_block_blocked_id_user_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_block_blocked_idx" ON "member_block" USING btree ("blocked_id");