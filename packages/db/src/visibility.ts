import { desc, eq, isNotNull, sql } from 'drizzle-orm';
import { getDatabase, queryable, type Executor } from './client';
import { recording, summary } from './schema';

/**
 * **The member visibility condition, written once.**
 *
 * Everything a member is allowed to read about a recording is decided in this file and nowhere
 * else — enforced by tests/guards/visibility-boundary.test.ts, which refuses a `published_at` null
 * predicate anywhere outside it.
 *
 * The guard exists because of what comes next rather than what exists now. Story 4's library and
 * recording page, Story 5's player and transcript, and Story 6's series listing are four more read
 * paths over the same rows, and a rule re-implemented per route is a rule that will be forgotten
 * on the fourth one — the failure being *a teaching nobody published becoming readable*, which is
 * the one failure this product cannot take back. A guard makes "written once" checkable rather
 * than reviewed.
 *
 * **Two gates, not one.** A recording is visible when `recording.published_at` is set
 * ([3.2.2](docs/project/prd.md)). Its *summary* is visible only when the summary's own
 * `published_at` is set **as well**, so [3.6.12](docs/project/prd.md)'s return-to-draft takes the
 * summary off a teaching that stays live. The description has no second gate: it is a column on the
 * recording and rides its state.
 *
 * Writing `published_at` is not comparing it — {@link setRecordingPublication} in `recordings.ts`
 * is the publish control, and a route that sets a timestamp decides nothing about who may read the
 * row.
 */

/** A recording and its summary, as far as the read paths are concerned. */
export interface VisibleRecordingRow {
  readonly id: string;
  readonly title: string;
  /** `YYYY-MM-DD`. A SQL `date`, so it comes back as the string it was written as. */
  readonly recordedAt: string;
  readonly publishedAt: Date | null;
  readonly description: string | null;
  /** The summary, **only when both gates are open**. `null` otherwise, whatever the row holds. */
  readonly summary: string | null;
  /** Admin-only at every call site. Never a URL. */
  readonly originalMediaKey: string;
  readonly createdAt: Date;
}

export interface VisibilityOptions {
  /**
   * `true` only for a caller the policy module says may see the console's list. Every other read
   * path in this epic and the next three passes `false` and inherits the rule.
   */
  readonly includeUnpublished: boolean;
}

/**
 * Recordings this caller may read, newest `recorded_at` first — the same order every other list
 * uses, so the product has one answer to "what is most recent".
 *
 * One statement: a left join onto `summary`, with the summary's text selected through the pair of
 * gates. The join is *left* because a published recording with no summary at all is still a
 * recording a member may see — an inner join would silently hide every teaching whose draft was
 * discarded, which [3.6.10](docs/project/prd.md) explicitly leaves publishable.
 */
export async function listVisibleRecordings(
  options: VisibilityOptions,
  executor: Executor = getDatabase(),
): Promise<VisibleRecordingRow[]> {
  const on = queryable(executor);

  // The whole condition, in the one place it is allowed to be written. Both timestamps, together:
  // a live teaching whose summary was returned to draft answers `null` here and nowhere else.
  const visibleSummary = sql<
    string | null
  >`case when ${summary.publishedAt} is not null and ${recording.publishedAt} is not null
      then ${summary.content} end`;

  const rows = await on
    .select({
      id: recording.id,
      title: recording.title,
      recordedAt: recording.recordedAt,
      publishedAt: recording.publishedAt,
      description: recording.description,
      summary: visibleSummary,
      originalMediaKey: recording.originalMediaKey,
      createdAt: recording.createdAt,
    })
    .from(recording)
    .leftJoin(summary, eq(summary.recordingId, recording.id))
    // The row gate. `undefined` is drizzle's "no predicate", so the admin read is the same
    // statement without a `where` rather than a second query somebody has to keep in step.
    .where(options.includeUnpublished ? undefined : isNotNull(recording.publishedAt))
    .orderBy(desc(recording.recordedAt), desc(recording.createdAt));

  return rows as unknown as VisibleRecordingRow[];
}
