CREATE TYPE "public"."flow_answer" AS ENUM('dont_remember', 'recall_slightly', 'remember_well', 'not_embodied', 'experience_daily');--> statement-breakpoint
CREATE TYPE "public"."flow_question_scope" AS ENUM('chapter', 'recording', 'tag');--> statement-breakpoint
CREATE TYPE "public"."flow_session_status" AS ENUM('in_progress', 'complete', 'abandoned');--> statement-breakpoint
ALTER TYPE "public"."pipeline_step" ADD VALUE 'generate_questions' BEFORE 'embed';--> statement-breakpoint
ALTER TYPE "public"."review_kind" ADD VALUE 'mind_map';--> statement-breakpoint
CREATE TABLE "flow_question" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "flow_question_scope" NOT NULL,
	"chapter_id" uuid,
	"recording_id" uuid,
	"tag_id" uuid,
	"text" text NOT NULL,
	"generated_by" jsonb,
	"edited_by_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_question_shape" CHECK (("flow_question"."scope" = 'chapter') = ("flow_question"."chapter_id" is not null)
        and ("flow_question"."scope" = 'recording') = ("flow_question"."recording_id" is not null)
        and ("flow_question"."scope" = 'tag') = ("flow_question"."tag_id" is not null)),
	CONSTRAINT "flow_question_text_length" CHECK (char_length("flow_question"."text") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "flow_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"divergence_recording_id" uuid NOT NULL,
	"status" "flow_session_status" DEFAULT 'in_progress' NOT NULL,
	"teaching_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone,
	CONSTRAINT "flow_session_status_timestamps" CHECK (("flow_session"."status" = 'complete') = ("flow_session"."completed_at" is not null)
        and ("flow_session"."status" = 'abandoned') = ("flow_session"."abandoned_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "flow_session_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" "flow_question_scope" NOT NULL,
	"recording_id" uuid,
	"chapter_id" uuid,
	"tag_id" uuid,
	"question" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"start_ms" integer,
	"answer" "flow_answer",
	"answered_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	CONSTRAINT "flow_session_item_position_positive" CHECK ("flow_session_item"."position" >= 1),
	CONSTRAINT "flow_session_item_shape" CHECK (("flow_session_item"."kind" = 'tag') = ("flow_session_item"."recording_id" is null)
        and ("flow_session_item"."answer" is null) = ("flow_session_item"."answered_at" is null)
        and ("flow_session_item"."start_ms" is null or "flow_session_item"."start_ms" >= 0))
);
--> statement-breakpoint
CREATE TABLE "mind_map" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_id" uuid NOT NULL,
	"root" jsonb NOT NULL,
	"edited_by_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flow_question" ADD CONSTRAINT "flow_question_chapter_id_chapter_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_question" ADD CONSTRAINT "flow_question_recording_id_recording_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recording"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_question" ADD CONSTRAINT "flow_question_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_session" ADD CONSTRAINT "flow_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_session" ADD CONSTRAINT "flow_session_divergence_recording_id_recording_id_fk" FOREIGN KEY ("divergence_recording_id") REFERENCES "public"."recording"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_session_item" ADD CONSTRAINT "flow_session_item_session_id_flow_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."flow_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_session_item" ADD CONSTRAINT "flow_session_item_recording_id_recording_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recording"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_session_item" ADD CONSTRAINT "flow_session_item_chapter_id_chapter_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_session_item" ADD CONSTRAINT "flow_session_item_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mind_map" ADD CONSTRAINT "mind_map_recording_id_recording_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recording"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "flow_question_chapter_unique" ON "flow_question" USING btree ("chapter_id") WHERE "flow_question"."scope" = 'chapter';--> statement-breakpoint
CREATE UNIQUE INDEX "flow_question_recording_unique" ON "flow_question" USING btree ("recording_id") WHERE "flow_question"."scope" = 'recording';--> statement-breakpoint
CREATE INDEX "flow_question_tag_idx" ON "flow_question" USING btree ("tag_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_session_one_in_progress" ON "flow_session" USING btree ("user_id") WHERE "flow_session"."status" = 'in_progress';--> statement-breakpoint
CREATE INDEX "flow_session_user_created_idx" ON "flow_session" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_session_item_position_unique" ON "flow_session_item" USING btree ("session_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "mind_map_recording_unique" ON "mind_map" USING btree ("recording_id");