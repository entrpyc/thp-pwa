CREATE TABLE "account_deletion_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_deletion_request" ADD CONSTRAINT "account_deletion_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_deletion_request_token_hash_unique" ON "account_deletion_request" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "account_deletion_request_live_user_unique" ON "account_deletion_request" USING btree ("user_id") WHERE "account_deletion_request"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_deleted_is_deactivated" CHECK ("user"."deleted_at" is null or "user"."deactivated_at" is not null);