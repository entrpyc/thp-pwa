CREATE TABLE "user_onboarding" (
	"user_id" uuid NOT NULL,
	"onboarding_id" text NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_onboarding_user_id_onboarding_id_pk" PRIMARY KEY("user_id","onboarding_id")
);
--> statement-breakpoint
ALTER TABLE "user_onboarding" ADD CONSTRAINT "user_onboarding_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;