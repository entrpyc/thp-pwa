CREATE TYPE "public"."pipeline_step" AS ENUM('transcribe', 'generate_draft');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'member');