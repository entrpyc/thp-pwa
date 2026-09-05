CREATE TABLE "recording_tag" (
	"recording_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recording_tag_recording_id_tag_id_pk" PRIMARY KEY("recording_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "series_tag" (
	"series_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_tag_series_id_tag_id_pk" PRIMARY KEY("series_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_name_normalised" CHECK ("tag"."name" <> '' and "tag"."name" = lower(btrim("tag"."name"))),
	CONSTRAINT "tag_name_length" CHECK (char_length("tag"."name") <= 40)
);
--> statement-breakpoint
ALTER TABLE "recording_tag" ADD CONSTRAINT "recording_tag_recording_id_recording_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recording"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_tag" ADD CONSTRAINT "recording_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_tag" ADD CONSTRAINT "series_tag_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_tag" ADD CONSTRAINT "series_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recording_tag_tag_id_idx" ON "recording_tag" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "series_tag_tag_id_idx" ON "series_tag" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_name_unique" ON "tag" USING btree ("name");