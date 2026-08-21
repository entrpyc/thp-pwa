CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_id" uuid NOT NULL,
	"step" "pipeline_step" NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"attempt" integer NOT NULL,
	"error" text,
	"correlation_id" text NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"provider_meta" jsonb
);
--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_recording_id_recording_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recording"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_unfinished_step_unique" ON "job" USING btree ("recording_id","step") WHERE "job"."status" in ('pending', 'running');