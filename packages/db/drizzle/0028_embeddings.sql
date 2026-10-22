-- Hand-written, above everything drizzle-kit generated: the extension that gives Postgres the
-- `vector` type the table below is declared with. drizzle-kit knows the column type but does not
-- emit `CREATE EXTENSION`, and a migration that created the table first would fail on the type.
-- `IF NOT EXISTS` so a database where an operator enabled it by hand migrates the same as one
-- where they did not. This is the epic that enables pgvector (README.md, "Database"): the
-- instance has shipped it installed-but-disabled since the first migration, and
-- packages/db/tests/integration/pgvector.test.ts now asserts the enabled state.
--
-- The HNSW index at the bottom is generated — drizzle-kit 0.31 emits the method and the operator
-- class from the schema declaration — and it is kept there rather than moved up here so the
-- snapshot and the statement stay one thing.
create extension if not exists vector;--> statement-breakpoint
CREATE TYPE "public"."embedding_source" AS ENUM('segment', 'chapter', 'note', 'summary', 'series');--> statement-breakpoint
ALTER TYPE "public"."pipeline_step" ADD VALUE 'embed' BEFORE 'reprocess_audio';--> statement-breakpoint
CREATE TABLE "embedding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_kind" "embedding_source" NOT NULL,
	"source_id" uuid NOT NULL,
	"recording_id" uuid,
	"owner_user_id" uuid,
	"text" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_recording_per_kind" CHECK (("embedding"."source_kind" = 'series') = ("embedding"."recording_id" is null)),
	CONSTRAINT "embedding_owner_only_on_note" CHECK ("embedding"."owner_user_id" is null or "embedding"."source_kind" = 'note')
);
--> statement-breakpoint
ALTER TABLE "embedding" ADD CONSTRAINT "embedding_recording_id_recording_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recording"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding" ADD CONSTRAINT "embedding_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_source_unique" ON "embedding" USING btree ("source_kind","source_id");--> statement-breakpoint
CREATE INDEX "embedding_recording_idx" ON "embedding" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "embedding_vector_hnsw_idx" ON "embedding" USING hnsw ("embedding" vector_cosine_ops);