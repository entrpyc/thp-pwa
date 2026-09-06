CREATE TABLE "spend_ceiling_raise" (
	"day" date PRIMARY KEY NOT NULL,
	"ceiling_usd" numeric(10, 2) NOT NULL,
	"raised_by" uuid,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	CONSTRAINT "spend_ceiling_raise_positive" CHECK ("spend_ceiling_raise"."ceiling_usd" > 0),
	CONSTRAINT "spend_ceiling_raise_reason_length" CHECK (char_length("spend_ceiling_raise"."reason") <= 200)
);
--> statement-breakpoint
ALTER TABLE "spend_ceiling_raise" ADD CONSTRAINT "spend_ceiling_raise_raised_by_user_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;