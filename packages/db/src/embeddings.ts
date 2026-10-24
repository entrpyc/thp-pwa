import { and, eq, inArray, sql } from 'drizzle-orm';
import type { EmbeddingSourceKind } from '@thp/shared';
import { getDatabase, queryable, type Executor } from './client';
import { embedding } from './schema';

/**
 * **Every statement against `embedding`** — the vectors semantic search
 * ([3.10](docs/project/prd.md)) and cross-referencing ([3.9](docs/project/prd.md)) will read,
 * written here by the worker's `embed` step and by the two web paths that remove a source
 * outright (a deleted note, an unpublished summary).
 *
 * **What is not here is visibility.** No statement in this file decides which rows a member may
 * see: that is `visibility.ts`'s condition, stated once, and tests/guards/visibility-boundary
 * refuses a second copy. This module answers *which rows exist for this recording* and *write
 * these*, and nothing about who is asking.
 *
 * **No similarity query is here either**, deliberately. Search and cross-referencing own the
 * `<=>` they need and the fusion around it (project tdd 4.5); writing a query now with no caller
 * would be a query nobody tested against what it is for.
 *
 * **Crosses its boundary as row types in and row types out**, plus an {@link Executor} so a caller
 * can pull a write into a transaction — the same shape every other module in this package takes.
 * Drizzle never leaves the package.
 */

/** One `embedding` row, without the vector — which nothing in this epic reads back. */
export interface EmbeddingRow {
  readonly id: string;
  readonly sourceKind: EmbeddingSourceKind;
  readonly sourceId: string;
  readonly recordingId: string | null;
  readonly ownerUserId: string | null;
  /** The words the vector was computed from — what a re-run compares against before spending. */
  readonly text: string;
  readonly model: string;
  /**
   * The passage window's first and last sentence ids on a `segment` row (`@thp/shared`
   * `passages.ts`); `null` on every other kind, and on a segment row written before windows.
   */
  readonly windowFirstSegmentId: string | null;
  readonly windowLastSegmentId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What the embed step writes for one source. */
export interface NewEmbedding {
  readonly sourceKind: EmbeddingSourceKind;
  readonly sourceId: string;
  readonly recordingId: string | null;
  readonly ownerUserId: string | null;
  readonly text: string;
  readonly vector: readonly number[];
  readonly model: string;
  /** The window's extent, on a `segment` row. Omitted or `null` elsewhere — the check constraint insists. */
  readonly windowFirstSegmentId?: string | null;
  readonly windowLastSegmentId?: string | null;
}

/** The columns every read below returns — named, so the vector stays in the table. */
const EMBEDDING_COLUMNS = {
  id: embedding.id,
  sourceKind: embedding.sourceKind,
  sourceId: embedding.sourceId,
  recordingId: embedding.recordingId,
  ownerUserId: embedding.ownerUserId,
  text: embedding.text,
  model: embedding.model,
  windowFirstSegmentId: embedding.windowFirstSegmentId,
  windowLastSegmentId: embedding.windowLastSegmentId,
  createdAt: embedding.createdAt,
  updatedAt: embedding.updatedAt,
} as const;

/**
 * Everything embedded for one recording, whatever its kind.
 *
 * The read the embed step starts from: compared against the recording's current sources, it says
 * which rows are stale, which are missing and which sources no longer exist — so a re-run after
 * one corrected line ([3.5.5](docs/project/prd.md)) spends one call rather than one per segment.
 */
export async function listEmbeddingsForRecording(
  recordingId: string,
  executor: Executor = getDatabase(),
): Promise<EmbeddingRow[]> {
  const rows = await queryable(executor)
    .select(EMBEDDING_COLUMNS)
    .from(embedding)
    .where(eq(embedding.recordingId, recordingId));
  return rows as EmbeddingRow[];
}

/** The rows for some sources of one kind, for a test or a caller checking what a write left. */
export async function findEmbeddingsForSources(
  sourceKind: EmbeddingSourceKind,
  sourceIds: readonly string[],
  executor: Executor = getDatabase(),
): Promise<EmbeddingRow[]> {
  if (sourceIds.length === 0) return [];
  const rows = await queryable(executor)
    .select(EMBEDDING_COLUMNS)
    .from(embedding)
    .where(and(eq(embedding.sourceKind, sourceKind), inArray(embedding.sourceId, [...sourceIds])));
  return rows as EmbeddingRow[];
}

/**
 * Write vectors, **replacing** any row the same source already has.
 *
 * An upsert on `(source_kind, source_id)` rather than a delete-and-insert, so a source is never
 * absent from the table between the two statements — a search running while a line is being
 * re-embedded sees the old vector or the new one, never a hole. `created_at` is left alone on a
 * replace and `updated_at` moves, which is how a reader can tell a row re-embedded after a
 * correction from one that has sat unchanged since the chain ran.
 *
 * Dispatch is at-least-once, and this is what lets the step be run twice: the second run finds
 * every source unchanged and writes nothing.
 */
export async function upsertEmbeddings(
  rows: readonly NewEmbedding[],
  executor: Executor = getDatabase(),
): Promise<void> {
  if (rows.length === 0) return;
  await queryable(executor)
    .insert(embedding)
    .values(
      rows.map((row) => ({
        sourceKind: row.sourceKind,
        sourceId: row.sourceId,
        recordingId: row.recordingId,
        ownerUserId: row.ownerUserId,
        text: row.text,
        embedding: [...row.vector],
        model: row.model,
        windowFirstSegmentId: row.windowFirstSegmentId ?? null,
        windowLastSegmentId: row.windowLastSegmentId ?? null,
      })),
    )
    .onConflictDoUpdate({
      target: [embedding.sourceKind, embedding.sourceId],
      set: {
        recordingId: sql`excluded.recording_id`,
        ownerUserId: sql`excluded.owner_user_id`,
        text: sql`excluded.text`,
        embedding: sql`excluded.embedding`,
        model: sql`excluded.model`,
        windowFirstSegmentId: sql`excluded.window_first_segment_id`,
        windowLastSegmentId: sql`excluded.window_last_segment_id`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Remove every row of one kind a recording has — what the passage backfill calls before it runs
 * the embed step, so a library embedded one row per sentence is rebuilt one row per window
 * rather than reconciled against ids the builder no longer names. Inside the caller's
 * transaction, so a search never sees the recording with no transcript rows at all.
 *
 * Answers how many rows went.
 */
export async function deleteEmbeddingsOfKindForRecording(
  recordingId: string,
  sourceKind: EmbeddingSourceKind,
  executor: Executor = getDatabase(),
): Promise<number> {
  const deleted = await queryable(executor)
    .delete(embedding)
    .where(and(eq(embedding.recordingId, recordingId), eq(embedding.sourceKind, sourceKind)))
    .returning({ id: embedding.id });
  return deleted.length;
}

/**
 * Remove the rows for some sources of one kind — what a deleted note
 * ([3.12.9](docs/project/prd.md)) and a summary returned to draft ([3.6.12](docs/project/prd.md))
 * call, inside the transaction that removes the source, so there is no moment at which a vector
 * stands for words that are no longer there to be read. The embed step calls it too, for sources
 * that disappeared between two runs.
 *
 * Answers how many rows went, so a caller asserting "nothing was there" can.
 */
export async function deleteEmbeddingsForSources(
  sourceKind: EmbeddingSourceKind,
  sourceIds: readonly string[],
  executor: Executor = getDatabase(),
): Promise<number> {
  if (sourceIds.length === 0) return 0;
  const deleted = await queryable(executor)
    .delete(embedding)
    .where(and(eq(embedding.sourceKind, sourceKind), inArray(embedding.sourceId, [...sourceIds])))
    .returning({ id: embedding.id });
  return deleted.length;
}
