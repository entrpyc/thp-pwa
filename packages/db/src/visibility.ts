import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { getDatabase, queryable, type Executor } from './client';
import { playbackProgress, recording, scriptureReference, series, summary } from './schema';

/**
 * **The member visibility condition, written once.**
 *
 * Everything a member is allowed to read about a recording is decided in this file and nowhere
 * else — enforced by tests/guards/visibility-boundary.test.ts, which refuses a `published_at` null
 * predicate anywhere outside it.
 *
 * The guard existed because of what came next rather than what existed then, and **the fifth and
 * sixth read paths are now in this file**: Story 4's library and recording page, Story 5's player
 * and transcript, and Story 6's series listing and series page. A rule re-implemented per route is
 * a rule that gets forgotten on the fourth one — the failure being *a teaching nobody published
 * becoming readable*, which is the one failure this product cannot take back. A guard makes
 * "written once" checkable rather than reviewed.
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
  /** The series this recording is in, or `null` for the many in none (Story 6). */
  readonly seriesId: string | null;
  readonly seriesTitle: string | null;
  /**
   * Whether this teaching has any approved scripture reference at all (Group 4).
   *
   * Counted rather than stored, in the same statement that reads the row — the shape
   * {@link VisibleSeriesRow}'s aggregates already take. **Whether there is a reference and what it
   * says are two different reads**, and this is the cheap one: the recording page asks it to decide
   * whether to draw a tab, and asks the other only if the member presses it.
   *
   * A reference exists only because an admin approved the list it was in, so there is no second
   * gate to apply here — the row gate above is the whole of who may see this.
   */
  readonly hasScripture: boolean;
}

/**
 * `true` when this recording has at least one approved reference.
 *
 * `exists` rather than a count or a join: nothing wants the number, and a join would multiply the
 * recording row by its references and turn a one-row read into a `group by`.
 */
const hasScripture = sql<boolean>`exists (
  select 1 from ${scriptureReference} where ${scriptureReference.recordingId} = ${recording.id}
)`;

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
      seriesId: recording.seriesId,
      seriesTitle: series.title,
      hasScripture,
    })
    .from(recording)
    .leftJoin(summary, eq(summary.recordingId, recording.id))
    // Left, not inner: a recording in no series is the ordinary case (3.3.9), and an inner join
    // here would silently empty the library.
    .leftJoin(series, eq(series.id, recording.seriesId))
    // The row gate. `undefined` is drizzle's "no predicate", so the admin read is the same
    // statement without a `where` rather than a second query somebody has to keep in step.
    .where(options.includeUnpublished ? undefined : isNotNull(recording.publishedAt))
    .orderBy(desc(recording.recordedAt), desc(recording.createdAt));

  return rows as unknown as VisibleRecordingRow[];
}

/**
 * One recording this caller may read, or `null` (Story 4 Ticket 01).
 *
 * **The same statement as the list, narrowed to an id** — both gates, the same left join, the same
 * `includeUnpublished` boolean. Written here rather than beside the recording page's route for the
 * reason the whole file exists: this is the fourth read path over these rows, and the fourth is
 * exactly where a re-implemented rule gets forgotten.
 *
 * `null` covers both "no such recording" and "not published for you". The caller answers the two
 * identically, so the API does not report which ids exist.
 */
export async function findVisibleRecording(
  id: string,
  options: VisibilityOptions,
  executor: Executor = getDatabase(),
): Promise<VisibleRecordingRow | null> {
  const on = queryable(executor);

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
      seriesId: recording.seriesId,
      seriesTitle: series.title,
      hasScripture,
    })
    .from(recording)
    .leftJoin(summary, eq(summary.recordingId, recording.id))
    // Left, not inner: a recording in no series is the ordinary case (3.3.9), and an inner join
    // here would silently empty the library.
    .leftJoin(series, eq(series.id, recording.seriesId))
    .where(
      options.includeUnpublished
        ? eq(recording.id, id)
        : and(eq(recording.id, id), isNotNull(recording.publishedAt)),
    )
    .limit(1);

  return (rows[0] as VisibleRecordingRow | undefined) ?? null;
}

/** What the landing's *Resume recording* card is built from. */
export interface ResumeProgressRow {
  readonly recordingId: string;
  readonly title: string;
  readonly description: string | null;
  readonly positionMs: number;
}

/**
 * The teaching this member was last part-way through, **still published**, or `null`
 * (Story 4 Ticket 04, [3.2.5](docs/project/prd.md)).
 *
 * In this file rather than in `playback.ts` because of the join: choosing what to offer means
 * asking whether the recording is still visible, and comparing `published_at` is this module's and
 * nothing else's. A teaching taken back down by [3.2.11](docs/project/prd.md) does not reappear
 * through a resume card — the row stays where it is, and re-publishing brings it back.
 *
 * Ordered by when the position was written, not by the recording's date: the card answers "what
 * were you last listening to", which is a fact about the listening rather than about the teaching.
 */
export async function findResumeProgress(
  userId: string,
  executor: Executor = getDatabase(),
): Promise<ResumeProgressRow | null> {
  const rows = await queryable(executor)
    .select({
      recordingId: recording.id,
      title: recording.title,
      description: recording.description,
      positionMs: playbackProgress.positionMs,
    })
    .from(playbackProgress)
    .innerJoin(recording, eq(recording.id, playbackProgress.recordingId))
    .where(and(eq(playbackProgress.userId, userId), isNotNull(recording.publishedAt)))
    .orderBy(desc(playbackProgress.updatedAt))
    .limit(1);

  return (rows[0] as ResumeProgressRow | undefined) ?? null;
}

/**
 * A series, with the two things about it that are **counted rather than stored** (Story 6).
 *
 * `recordingCount`, `firstRecordedAt` and `lastRecordedAt` are aggregates over the recordings the
 * caller may see, computed in the same statement that reads the series. That is why the console's
 * answer for a series and a member's answer for the same series can legitimately differ, and it is
 * why [4.3](docs/project/prd.md)'s "auto-calculated" is a query rather than a column somebody has
 * to remember to keep in step.
 */
export interface VisibleSeriesRow {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  /**
   * The object key of this series' cover, or `null`.
   *
   * **A key and not a URL**, and it stops here: the layer above turns it into a signed grant minted
   * for that response (scope tdd 1.4), because signing is not a database concern and a stored URL
   * would be a stored expiry. `null` is the ordinary state (scope prd 3.1.7), not an absence the
   * caller has to interpret.
   */
  readonly artworkKey: string | null;
  readonly recordingCount: number;
  /** `YYYY-MM-DD`, or `null` when the series holds nothing this caller may see. */
  readonly firstRecordedAt: string | null;
  readonly lastRecordedAt: string | null;
}

/** One row of a series page — a recording, with this member's own position in it. */
export interface VisibleSeriesRecordingRow {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  /** `YYYY-MM-DD`. */
  readonly recordedAt: string;
  /** This member's stored position, or `null` when they have never started it. */
  readonly positionMs: number | null;
}

/** A series and the recordings in it, as one caller may read them. */
export interface VisibleSeriesDetail {
  readonly series: VisibleSeriesRow;
  readonly recordings: readonly VisibleSeriesRecordingRow[];
}

/**
 * Series this caller may read (Story 6 Ticket 02) — **the fifth read path over these rows**, and
 * the reason this module exists rather than a query beside the route that wants it.
 *
 * One statement, and `includeUnpublished` decides three things at once:
 *
 * - **Which recordings are counted.** The join carries the row gate, so a member's count and date
 *   range are over published recordings only ([3.2.2](docs/project/prd.md)) and the console's are
 *   over everything assigned.
 * - **Whether an empty series comes back.** The console has to see one — it is where an empty
 *   series becomes fillable — and a member must not, because a series with nothing published in it
 *   is a series with nothing to open. That is the `having` below.
 * - **Nothing about who may ask.** The policy module answers that, and this boolean never widens
 *   what a caller may see.
 *
 * Ordered by the most recent recording in the series, newest first — the product's one answer to
 * "what is most recent" ([3.3.1](docs/project/prd.md)) applied to a series rather than a teaching.
 * A series holding nothing sorts last (`nulls last`) and then by title, so the console's empty
 * series are appended in a readable order rather than scattered.
 */
export async function listVisibleSeries(
  options: VisibilityOptions,
  executor: Executor = getDatabase(),
): Promise<VisibleSeriesRow[]> {
  // The row gate, carried on the *join* rather than in a `where`: a series with no visible
  // recording must still reach the `having` below to be counted as empty, and a `where` would drop
  // it before it got there.
  const counted = options.includeUnpublished
    ? eq(recording.seriesId, series.id)
    : and(eq(recording.seriesId, series.id), isNotNull(recording.publishedAt));

  const rows = await queryable(executor)
    .select({
      id: series.id,
      title: series.title,
      description: series.description,
      artworkKey: series.artworkKey,
      recordingCount: sql<number>`count(${recording.id})::int`,
      firstRecordedAt: sql<string | null>`min(${recording.recordedAt})::text`,
      lastRecordedAt: sql<string | null>`max(${recording.recordedAt})::text`,
    })
    .from(series)
    .leftJoin(recording, counted)
    .groupBy(series.id, series.title, series.description, series.artworkKey)
    .having(options.includeUnpublished ? undefined : sql`count(${recording.id}) > 0`)
    .orderBy(sql`max(${recording.recordedAt}) desc nulls last`, asc(series.title));

  return rows as unknown as VisibleSeriesRow[];
}

/**
 * One series and everything in it this caller may read, or `null` (Story 6 Ticket 02).
 *
 * **The same gate as the list, plus this member's own progress.** The join onto
 * `playback_progress` is on `(user_id, recording_id)` for the requesting account and nobody else's,
 * which is the whole of "and only their own" — two members reading the same series row get two
 * different positions out of one query and neither can see the other's.
 *
 * **Oldest recorded first**, the reverse of the library. Both orders are correct and they are
 * opposite: [3.3.1](docs/project/prd.md) makes newest-first the product's default reading and
 * [3.3.4](docs/project/prd.md) asks for chronological inside a series, because a study is read
 * forwards. There is no ordering column and no numbering here — the `01.`–`08.` the reference
 * draws is the row's position in this order, computed for display by whatever renders it.
 *
 * `null` covers "no such series" and "nothing in it you may see" alike, so the API does not report
 * which ids exist.
 */
export async function findVisibleSeries(
  id: string,
  userId: string,
  options: VisibilityOptions,
  executor: Executor = getDatabase(),
): Promise<VisibleSeriesDetail | null> {
  const on = queryable(executor);

  const found = await on.select().from(series).where(eq(series.id, id)).limit(1);
  const row = found[0] as
    | { id: string; title: string; description: string | null; artworkKey: string | null }
    | undefined;
  if (row === undefined) return null;

  const rows = await on
    .select({
      id: recording.id,
      title: recording.title,
      description: recording.description,
      recordedAt: recording.recordedAt,
      positionMs: playbackProgress.positionMs,
    })
    .from(recording)
    .leftJoin(
      playbackProgress,
      and(
        eq(playbackProgress.recordingId, recording.id),
        eq(playbackProgress.userId, userId),
      ),
    )
    .where(
      options.includeUnpublished
        ? eq(recording.seriesId, id)
        : and(eq(recording.seriesId, id), isNotNull(recording.publishedAt)),
    )
    .orderBy(asc(recording.recordedAt), asc(recording.createdAt));

  const recordings = rows as unknown as VisibleSeriesRecordingRow[];

  // A series holding nothing this caller may see answers exactly as one that never existed. The
  // console asks with the gate open and does get an empty series back, which is the one caller
  // that has a reason to look at one.
  if (recordings.length === 0 && !options.includeUnpublished) return null;

  return {
    series: {
      id: row.id,
      title: row.title,
      description: row.description,
      artworkKey: row.artworkKey,
      recordingCount: recordings.length,
      firstRecordedAt: recordings[0]?.recordedAt ?? null,
      lastRecordedAt: recordings[recordings.length - 1]?.recordedAt ?? null,
    },
    recordings,
  };
}
