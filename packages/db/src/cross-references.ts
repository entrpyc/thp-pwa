import { desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { CrossReferenceBasis } from '@thp/shared';
import { getDatabase, queryable, withTransaction, type Executor } from './client';
import { crossReference, embedding, recording, segment, series } from './schema';
import { recordingWithIdIsPublished } from './visibility';

/**
 * **Every statement against `cross_reference`** ([3.9](docs/project/prd.md); project tdd 3.3 and
 * 5.7) — the nearest-neighbour read the worker's `cross_reference` step starts from, the replace
 * it ends with, the removal unpublishing makes, and the read the recording page makes while a
 * member listens.
 *
 * **The similarity query is here**, where `embeddings.ts` deliberately left it: it has a caller
 * now, and that caller's needs shape it — segments only, other recordings only, published
 * recordings only, `k` per source sentence in one round trip.
 *
 * **Visibility is not decided here.** Both places this file needs "that recording is published"
 * take the fragment `visibility.ts` exports for exactly this purpose; the predicate is spelled
 * there and tests/guards/visibility-boundary refuses it anywhere else. What this module decides is
 * *which rows exist* and *write these*, and nothing about who is asking — the service in front of
 * the read asks `findVisibleRecording` about the teaching itself.
 *
 * Crosses its boundary as row types in and row types out, plus an {@link Executor}, like every
 * other module here. Drizzle never leaves the package.
 */

/** One `cross_reference` row, as stored. */
export interface CrossReferenceRow {
  readonly id: string;
  readonly sourceRecordingId: string;
  readonly sourceSegmentId: string;
  readonly targetRecordingId: string;
  readonly targetSegmentId: string;
  readonly score: number;
  readonly basis: CrossReferenceBasis;
  readonly computedFor: string;
  readonly createdAt: Date;
}

/**
 * One link as the step found it — **undirected**. {@link replaceCrossReferencesForRun} writes
 * it as two rows, one from each side, so no caller has to remember to mirror.
 */
export interface NewCrossReference {
  readonly sourceRecordingId: string;
  readonly sourceSegmentId: string;
  readonly targetRecordingId: string;
  readonly targetSegmentId: string;
  readonly score: number;
  readonly basis: CrossReferenceBasis;
}

/** A candidate the index answered for one source sentence. */
export interface NearestSegmentRow {
  readonly sourceSegmentId: string;
  readonly targetSegmentId: string;
  readonly targetRecordingId: string;
  /** Cosine similarity, `1 - distance`, in 0..1 for unit vectors. */
  readonly score: number;
}

/**
 * **The `k` nearest sentences of other published teachings, for each of these sentences.**
 *
 * One statement for the whole batch: a lateral subquery per source vector, ordered by cosine
 * distance with a `limit`, which is the shape pgvector's HNSW index serves (project tdd 4.4).
 * The source vectors are read from the same table, so the step never holds a vector in memory
 * and never sends one across the wire.
 *
 * Three filters inside the lateral, in the order they matter:
 *
 * - **segments only** — a sentence is linked to a sentence, never to a chapter summary or a note
 *   ([3.9.1](docs/project/prd.md));
 * - **another recording** — a teaching's nearest sentence is usually its own next sentence, and
 *   a link to itself is not a cross-reference;
 * - **a published one** — the gate, as `visibility.ts` spells it. A draft neither gives nor
 *   receives links, and asking the index for its sentences would be the step deciding visibility.
 *
 * A filtered HNSW scan can answer **fewer than `k`** rows when many of the nearest candidates are
 * filtered out — pgvector widens its candidate set only up to `hnsw.ef_search`. That is accepted
 * rather than worked around with a larger `k` and a second pass: a source sentence whose nearest
 * forty neighbours are all its own teaching or all drafts has, for the step's purposes, no
 * strong match, and the per-chapter cap keeps the step from needing many candidates anyway.
 *
 * A source sentence with no vector — one `embed` has not reached yet — answers nothing, which is
 * the honest state rather than an error; the chain runs this step after `embed` for that reason.
 */
export async function findNearestSegments(
  sourceSegmentIds: readonly string[],
  k: number,
  executor: Executor = getDatabase(),
): Promise<NearestSegmentRow[]> {
  if (sourceSegmentIds.length === 0) return [];

  const rows = await queryable(executor).execute(sql`
    select
      q.source_id as "sourceSegmentId",
      n.source_id as "targetSegmentId",
      n.recording_id as "targetRecordingId",
      n.score
    from ${embedding} as q
    cross join lateral (
      select
        e.source_id,
        e.recording_id,
        1 - (e.embedding <=> q.embedding) as score
      from ${embedding} as e
      where e.source_kind = 'segment'
        and e.recording_id <> q.recording_id
        and ${recordingWithIdIsPublished(sql`e.recording_id`)}
      order by e.embedding <=> q.embedding
      limit ${k}
    ) as n
    where q.source_kind = 'segment'
      and q.source_id in (${sql.join(
        sourceSegmentIds.map((id) => sql`${id}`),
        sql`, `,
      )})
  `);

  return (rows as unknown as NearestSegmentRow[]).map((row) => ({
    ...row,
    // `real` arithmetic comes back as a number already, but a driver can hand a `numeric` back as
    // text; one coercion here keeps every caller comparing numbers.
    score: Number(row.score),
  }));
}

/**
 * **Make these the links this recording's run found** — the step's one write.
 *
 * Delete every row the run owns, insert the new ones **in both directions**, inside one
 * transaction: a reader sees the previous run's links or this run's, never half of each and never
 * none. `computed_for` is what scopes the delete, so rows other teachings' runs wrote under this
 * recording's segments survive — they are those runs' to replace ([3.9.6](docs/project/prd.md)).
 *
 * An empty list is a legitimate write: a teaching whose run found nothing, or one that is no
 * longer published, ends with no rows of its own. That is what makes the step idempotent under
 * at-least-once dispatch and what makes running it on an unpublished teaching a clean no-op.
 */
export async function replaceCrossReferencesForRun(
  recordingId: string,
  links: readonly NewCrossReference[],
  executor: Executor = getDatabase(),
): Promise<void> {
  await withTransaction(async (tx) => {
    await queryable(tx).delete(crossReference).where(eq(crossReference.computedFor, recordingId));
    if (links.length === 0) return;
    await queryable(tx)
      .insert(crossReference)
      .values(
        links.flatMap((link) => [
          {
            sourceRecordingId: link.sourceRecordingId,
            sourceSegmentId: link.sourceSegmentId,
            targetRecordingId: link.targetRecordingId,
            targetSegmentId: link.targetSegmentId,
            score: link.score,
            basis: link.basis,
            computedFor: recordingId,
          },
          {
            sourceRecordingId: link.targetRecordingId,
            sourceSegmentId: link.targetSegmentId,
            targetRecordingId: link.sourceRecordingId,
            targetSegmentId: link.sourceSegmentId,
            score: link.score,
            basis: link.basis,
            computedFor: recordingId,
          },
        ]),
      );
  }, executor);
}

/**
 * **Remove every link touching this recording, on either end** — what unpublishing calls, in the
 * transaction that clears `published_at` ([3.2.11](docs/project/prd.md)).
 *
 * Both ends rather than only the rows the recording's own run wrote, because other teachings'
 * runs have written rows pointing at it, and those must go too: an unpublished teaching neither
 * gives nor receives links. Re-publishing enqueues the step, which rebuilds the recording's own
 * links; the links *other* teachings had found to it return only when their runs next execute,
 * which is stated rather than hidden — a re-publish is rare and the alternative is the step
 * re-running the whole library.
 *
 * Answers how many rows went, so a caller asserting "nothing was there" can.
 */
export async function deleteCrossReferencesTouching(
  recordingId: string,
  executor: Executor = getDatabase(),
): Promise<number> {
  const deleted = await queryable(executor)
    .delete(crossReference)
    .where(
      or(
        eq(crossReference.sourceRecordingId, recordingId),
        eq(crossReference.targetRecordingId, recordingId),
      ),
    )
    .returning({ id: crossReference.id });
  return deleted.length;
}

/** Every stored row touching this recording on either end, for a test or a caller checking a write. */
export async function listCrossReferencesTouching(
  recordingId: string,
  executor: Executor = getDatabase(),
): Promise<CrossReferenceRow[]> {
  const rows = await queryable(executor)
    .select()
    .from(crossReference)
    .where(
      or(
        eq(crossReference.sourceRecordingId, recordingId),
        eq(crossReference.targetRecordingId, recordingId),
      ),
    )
    .orderBy(desc(crossReference.score), crossReference.id);
  return rows as CrossReferenceRow[];
}

/** One link out of a teaching, with both moments and the other teaching named, as the page reads it. */
export interface OutgoingCrossReferenceRow {
  readonly sourceSegmentId: string;
  readonly sourceStartMs: number;
  readonly sourceEndMs: number;
  readonly sourceText: string;
  readonly targetRecordingId: string;
  readonly targetTitle: string;
  readonly targetSeriesId: string | null;
  readonly targetSeriesTitle: string | null;
  /** The series' cover key, or `null`. A key; the service signs it, as every other read's is. */
  readonly targetSeriesArtworkKey: string | null;
  readonly targetSegmentId: string;
  readonly targetStartMs: number;
  readonly targetText: string;
  readonly score: number;
  readonly basis: CrossReferenceBasis;
}

/**
 * **Every link out of this teaching whose target is published**, strongest first.
 *
 * The target gate is applied here as well as by unpublishing's delete, because the two are not
 * the same moment and [3.9](docs/project/prd.md)'s rule is absolute: a link to an unpublished
 * recording is never shown. The source side is not gated here — whether the member may read
 * *this* teaching is the service's question, asked of `findVisibleRecording` before this runs.
 *
 * Both segments and the target's series are joined in the one statement, so a page's read is one
 * round trip. Duplicates — the same pair found by both teachings' runs — come back as two rows,
 * and the service keeps the stronger; a `distinct on` here would have to choose a winner the
 * service is about to choose anyway.
 */
export async function listOutgoingCrossReferences(
  recordingId: string,
  executor: Executor = getDatabase(),
): Promise<OutgoingCrossReferenceRow[]> {
  const source = sql`src`;
  const target = sql`tgt`;
  const rows = await queryable(executor).execute(sql`
    select
      x.source_segment_id as "sourceSegmentId",
      ${source}.start_ms as "sourceStartMs",
      ${source}.end_ms as "sourceEndMs",
      ${source}.text as "sourceText",
      x.target_recording_id as "targetRecordingId",
      r.title as "targetTitle",
      s.id as "targetSeriesId",
      s.title as "targetSeriesTitle",
      s.artwork_key as "targetSeriesArtworkKey",
      x.target_segment_id as "targetSegmentId",
      ${target}.start_ms as "targetStartMs",
      ${target}.text as "targetText",
      x.score,
      x.basis
    from ${crossReference} as x
    join ${segment} as ${source} on ${source}.id = x.source_segment_id
    join ${segment} as ${target} on ${target}.id = x.target_segment_id
    join ${recording} as r on r.id = x.target_recording_id
    left join ${series} as s on s.id = r.series_id
    where x.source_recording_id = ${recordingId}
      and ${recordingWithIdIsPublished(sql`x.target_recording_id`)}
    order by x.score desc, ${source}.start_ms asc, x.id asc
  `);
  return (rows as unknown as OutgoingCrossReferenceRow[]).map((row) => ({
    ...row,
    score: Number(row.score),
  }));
}

/** The rows a set of recordings own, for a test asserting what a run left for each. */
export async function listCrossReferencesComputedFor(
  recordingIds: readonly string[],
  executor: Executor = getDatabase(),
): Promise<CrossReferenceRow[]> {
  if (recordingIds.length === 0) return [];
  const rows = await queryable(executor)
    .select()
    .from(crossReference)
    .where(inArray(crossReference.computedFor, [...recordingIds]))
    .orderBy(desc(crossReference.score), crossReference.id);
  return rows as CrossReferenceRow[];
}
