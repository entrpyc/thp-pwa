CREATE TABLE "recording" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"original_media_key" text NOT NULL,
	"title" text NOT NULL,
	"recorded_at" date NOT NULL,
	"published_at" timestamp with time zone,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "recording_original_media_key_unique" ON "recording" USING btree ("original_media_key");