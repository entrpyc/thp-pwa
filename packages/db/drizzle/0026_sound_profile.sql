ALTER TYPE "public"."pipeline_step" ADD VALUE 'reprocess_audio';--> statement-breakpoint
ALTER TYPE "public"."pipeline_step" ADD VALUE 'preview_audio';--> statement-breakpoint
CREATE TABLE "sound_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"noise_reduction_db" integer NOT NULL,
	"voice_clarity_db" integer NOT NULL,
	"loudness_target_lufs" integer NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sound_profile_version_unique" UNIQUE("version"),
	CONSTRAINT "sound_profile_version_positive" CHECK ("sound_profile"."version" > 0),
	CONSTRAINT "sound_profile_noise_reduction_range" CHECK ("sound_profile"."noise_reduction_db" between 0 and 30),
	CONSTRAINT "sound_profile_voice_clarity_range" CHECK ("sound_profile"."voice_clarity_db" between 0 and 6),
	CONSTRAINT "sound_profile_loudness_target_range" CHECK ("sound_profile"."loudness_target_lufs" between -24 and -12),
	CONSTRAINT "sound_profile_note_length" CHECK (char_length("sound_profile"."note") <= 200)
);
--> statement-breakpoint
ALTER TABLE "recording" ADD COLUMN "sound_profile_version" integer;--> statement-breakpoint
ALTER TABLE "sound_profile" ADD CONSTRAINT "sound_profile_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording" ADD CONSTRAINT "recording_sound_profile_version_sound_profile_version_fk" FOREIGN KEY ("sound_profile_version") REFERENCES "public"."sound_profile"("version") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Version 1, seeded by hand beneath what drizzle-kit generated: the shared defaults
-- (DEFAULT_SOUND_PROFILE in packages/shared/src/sound-profile.ts), so no recording is ever
-- processed under no profile. `created_by` is null — nobody saved it.
INSERT INTO "sound_profile" ("version", "noise_reduction_db", "voice_clarity_db", "loudness_target_lufs", "note")
VALUES (1, 12, 3, -16, 'The default profile.');
