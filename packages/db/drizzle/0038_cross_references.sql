CREATE TYPE "public"."cross_reference_basis" AS ENUM('semantic');--> statement-breakpoint
ALTER TYPE "public"."pipeline_step" ADD VALUE 'cross_reference' BEFORE 'reprocess_audio';--> statement-breakpoint
CREATE TABLE "cross_reference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_recording_id" uuid NOT NULL,
	"source_segment_id" uuid NOT NULL,
	"target_recording_id" uuid NOT NULL,
	"target_segment_id" uuid NOT NULL,
	"score" real NOT NULL,
	"basis" "cross_reference_basis" NOT NULL,
	"computed_for" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cross_reference_score_range" CHECK ("cross_reference"."score" between 0 and 1),
	CONSTRAINT "cross_reference_across_recordings" CHECK ("cross_reference"."source_recording_id" <> "cross_reference"."target_recording_id"),
	CONSTRAINT "cross_reference_owned_by_an_end" CHECK ("cross_reference"."computed_for" in ("cross_reference"."source_recording_id", "cross_reference"."target_recording_id"))
);
--> statement-breakpoint
ALTER TABLE "cross_reference" ADD CONSTRAINT "cross_reference_source_recording_id_recording_id_fk" FOREIGN KEY ("source_recording_id") REFERENCES "public"."recording"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_reference" ADD CONSTRAINT "cross_reference_source_segment_id_segment_id_fk" FOREIGN KEY ("source_segment_id") REFERENCES "public"."segment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_reference" ADD CONSTRAINT "cross_reference_target_recording_id_recording_id_fk" FOREIGN KEY ("target_recording_id") REFERENCES "public"."recording"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_reference" ADD CONSTRAINT "cross_reference_target_segment_id_segment_id_fk" FOREIGN KEY ("target_segment_id") REFERENCES "public"."segment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_reference" ADD CONSTRAINT "cross_reference_computed_for_recording_id_fk" FOREIGN KEY ("computed_for") REFERENCES "public"."recording"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cross_reference_pair_per_run_unique" ON "cross_reference" USING btree ("source_segment_id","target_segment_id","computed_for");--> statement-breakpoint
CREATE INDEX "cross_reference_source_recording_idx" ON "cross_reference" USING btree ("source_recording_id");--> statement-breakpoint
CREATE INDEX "cross_reference_target_recording_idx" ON "cross_reference" USING btree ("target_recording_id");--> statement-breakpoint
CREATE INDEX "cross_reference_computed_for_idx" ON "cross_reference" USING btree ("computed_for");