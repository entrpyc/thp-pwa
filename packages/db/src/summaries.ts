import { eq, sql } from 'drizzle-orm';
import { getDatabase, queryable, type Executor } from './client';
import { summary } from './schema';

/**
 * The approved summary's reads and writes (Story 3).
 *
 * Its own module beside `reviews.ts` because the two tables are two different things: a
 * `review_item` is a *proposal* an admin acts on once, and a `summary` is the **canonical entity**
 * approving one writes through to. Ticket 04's edit-after-publish and return-to-draft touch this
 * table and no review item at all, which is the clearest sign they are not the same concern.
 */

export interface SummaryRow {
  readonly id: string;
  readonly recordingId: string;
  readonly content: string;
  /** The second gate. `null` means a summary exists and no member can read it. */
  readonly publishedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Write this recording's summary, published.
 *
 * **Upsert on the unique index**, not a check-then-insert: approving a second draft for a
 * recording that already has a summary replaces the text rather than failing on the constraint or
 * growing a second row, and two approvals racing resolve at the database instead of in a window
 * between a `select` and an `insert`.
 *
 * `published_at` is set by this write, which is what makes approval and publication of the summary
 * one act ([3.6.7](docs/project/prd.md)) — the recording's own gate is the separate decision.
 */
export async function publishSummary(
  recordingId: string,
  content: string,
  executor: Executor = getDatabase(),
): Promise<SummaryRow> {
  const rows = await queryable(executor)
    .insert(summary)
    .values({ recordingId, content, publishedAt: sql`now()` })
    .onConflictDoUpdate({
      target: summary.recordingId,
      set: { content, publishedAt: sql`now()`, updatedAt: sql`now()` },
    })
    .returning();

  const row = rows[0] as SummaryRow | undefined;
  if (!row) throw new Error('publishSummary returned no row');
  return row;
}

/** This recording's summary, or `null`. There can never be two. */
export async function findSummaryByRecording(
  recordingId: string,
  executor: Executor = getDatabase(),
): Promise<SummaryRow | null> {
  const rows = await queryable(executor)
    .select()
    .from(summary)
    .where(eq(summary.recordingId, recordingId))
    .limit(1);
  return (rows[0] as SummaryRow | undefined) ?? null;
}

/**
 * Change the text without touching the gate ([3.6.11](docs/project/prd.md)).
 *
 * `published_at` is deliberately not in the `set`: editing a live summary leaves it live, which is
 * the whole of what "an admin can edit a summary after publish" means. Returning to draft is
 * {@link setSummaryPublication} and is a separate press.
 */
export async function updateSummaryContent(
  recordingId: string,
  content: string,
  executor: Executor = getDatabase(),
): Promise<SummaryRow | null> {
  const rows = await queryable(executor)
    .update(summary)
    .set({ content, updatedAt: sql`now()` })
    .where(eq(summary.recordingId, recordingId))
    .returning();
  return (rows[0] as SummaryRow | undefined) ?? null;
}

/**
 * Open or close the summary's gate, keeping the text.
 *
 * One write of `null` is the whole of [3.6.12](docs/project/prd.md)'s return-to-draft — which is
 * exactly why `published_at` is a nullable timestamp rather than a status column. Nothing is
 * deleted, so re-publishing is the same write with a timestamp.
 */
export async function setSummaryPublication(
  recordingId: string,
  published: boolean,
  executor: Executor = getDatabase(),
): Promise<SummaryRow | null> {
  const rows = await queryable(executor)
    .update(summary)
    .set({ publishedAt: published ? sql`now()` : null, updatedAt: sql`now()` })
    .where(eq(summary.recordingId, recordingId))
    .returning();
  return (rows[0] as SummaryRow | undefined) ?? null;
}
