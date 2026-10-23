-- Semantic search, the full-text half (project tdd 4.5; prd 3.10.5). A GIN expression index over
-- the words every vector in `embedding` was computed from, under the `english` configuration the
-- query in packages/db/src/search.ts spells identically. Nothing about the table changes: no
-- column, no trigger, no backfill — the index is built from the rows already there, and the embed
-- step goes on writing words it knows nothing about.
CREATE INDEX "embedding_text_search_idx" ON "embedding" USING gin (to_tsvector('english', "text"));