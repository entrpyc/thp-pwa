CREATE TABLE "playback_progress" (
	"user_id" uuid NOT NULL,
	"recording_id" uuid NOT NULL,
	"position_ms" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playback_progress_user_id_recording_id_pk" PRIMARY KEY("user_id","recording_id")
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "preferred_playback_speed" real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "playback_progress" ADD CONSTRAINT "playback_progress_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_progress" ADD CONSTRAINT "playback_progress_recording_id_recording_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recording"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_preferred_playback_speed_allowed" CHECK ("user"."preferred_playback_speed" in (0.5, 0.75, 1, 1.25, 1.5, 2));