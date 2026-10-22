/**
 * The embedding vocabulary — what semantic search ([3.10](docs/project/prd.md)) and
 * cross-referencing ([3.9](docs/project/prd.md)) are built on, stated once so the database column,
 * the worker's adapter and the search that reads them cannot disagree about the shape of a vector.
 *
 * **1536 dimensions** is project tdd 4.4's decision, and it is the model's native output rather
 * than a truncation: no step between the provider and the column changes what came back, which is
 * what makes "re-embed under a different model" the only migration there will ever be. The number
 * lives here rather than in the adapter because the *column* is sized by it — an adapter that
 * answered a different width would be refused by Postgres, and that refusal is the honest one.
 *
 * **The source kinds** are the things a vector can stand for. Each row in the `embedding` table
 * names one of these and the id of the row it was computed from, so a search hit can be carried
 * back to a moment in a teaching (a segment), a chapter, a note, a summary or a series. `series`
 * is declared now so the search scope can write those rows without a migration; nothing in this
 * epic produces one.
 */
export const EMBEDDING_DIMENSIONS = 1536;

export const EMBEDDING_SOURCE_KINDS = ['segment', 'chapter', 'note', 'summary', 'series'] as const;

export type EmbeddingSourceKind = (typeof EMBEDDING_SOURCE_KINDS)[number];

export function isEmbeddingSourceKind(value: unknown): value is EmbeddingSourceKind {
  return (
    typeof value === 'string' && (EMBEDDING_SOURCE_KINDS as readonly string[]).includes(value)
  );
}
