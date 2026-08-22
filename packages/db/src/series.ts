import { eq } from 'drizzle-orm';
import { getDatabase, queryable, type Executor } from './client';
import { recording, series } from './schema';

/**
 * **Series writes** (Story 6 Ticket 01) — create, rename, and put a recording into one.
 *
 * Query construction lives in this package and nowhere else, as everywhere: the import-boundary
 * guard refuses a `drizzle-orm` import from `packages/web`.
 *
 * **The reads are not here.** Listing series and opening one both have to answer "which recordings
 * may this person see" before they can count anything, and comparing `published_at` is
 * `visibility.ts`'s and nothing else's — so `listVisibleSeries` and `findVisibleSeries` live there,
 * guarded, beside the rest of the read rule. What is left in this file is the three writes and the
 * one lookup that decides whether a series exists at all.
 *
 * **No delete.** [3.3.6](docs/project/prd.md) names create, rename, reorder, merge and move, and no
 * delete; a series an admin regrets is renamed or emptied.
 */

export interface SeriesRow {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly createdAt: Date;
}

export interface NewSeries {
  readonly title: string;
  readonly description: string | null;
}

export async function insertSeries(
  input: NewSeries,
  executor: Executor = getDatabase(),
): Promise<SeriesRow> {
  const rows = await queryable(executor).insert(series).values(input).returning();
  const row = rows[0] as SeriesRow | undefined;
  if (!row) throw new Error('insertSeries returned no row');
  return row;
}

/**
 * Rename a series and rewrite its description.
 *
 * **This write touches the `series` row and nothing else.** No recording is read and none is
 * written, which is what makes "the recordings in it are unaffected" a property of the statement
 * rather than of the test that checks it.
 *
 * `null` back means there is no such series, which the caller turns into `not_found`.
 */
export async function updateSeries(
  id: string,
  input: NewSeries,
  executor: Executor = getDatabase(),
): Promise<SeriesRow | null> {
  const rows = await queryable(executor)
    .update(series)
    .set({ title: input.title, description: input.description })
    .where(eq(series.id, id))
    .returning();
  return (rows[0] as SeriesRow | undefined) ?? null;
}

/** One series, or `null`. What the assign route asks before it writes a foreign key. */
export async function findSeriesById(
  id: string,
  executor: Executor = getDatabase(),
): Promise<SeriesRow | null> {
  const rows = await queryable(executor).select().from(series).where(eq(series.id, id)).limit(1);
  return (rows[0] as SeriesRow | undefined) ?? null;
}

/**
 * Put a recording into a series, move it to another, or take it out.
 *
 * **One column is written and no other**, which is the whole of "moving a recording loses
 * nothing": the title, the date, the description, the summary, the transcript, the jobs and the
 * publication state are not in this statement, and neither is `playback_progress` — that table is
 * keyed on `(user_id, recording_id)` and no series write goes near it.
 *
 * `null` for `seriesId` takes the recording out of every series, which is the state
 * [3.3.9](docs/project/prd.md) makes ordinary. `null` back means there is no such recording.
 */
export async function setRecordingSeries(
  recordingId: string,
  seriesId: string | null,
  executor: Executor = getDatabase(),
): Promise<{ readonly id: string; readonly seriesId: string | null } | null> {
  const rows = await queryable(executor)
    .update(recording)
    .set({ seriesId })
    .where(eq(recording.id, recordingId))
    .returning({ id: recording.id, seriesId: recording.seriesId });
  return (rows[0] as { id: string; seriesId: string | null } | undefined) ?? null;
}
