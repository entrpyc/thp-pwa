import { eq } from 'drizzle-orm';
import { getDatabase, queryable, type Executor } from './client';
import { recording } from './schema';

/**
 * Recording reads and writes. Query construction lives in this package and nowhere else — the
 * import-boundary guard refuses a `drizzle-orm` import from `packages/web`, so "the API reaches
 * Postgres through one module" is enforced rather than intended.
 */

export interface RecordingRow {
  readonly id: string;
  /** Where the original sits in the object store. Unique — one object, one recording. */
  readonly originalMediaKey: string;
  readonly title: string;
  /** `YYYY-MM-DD`. A SQL `date`, so it comes back as the string it was written as. */
  readonly recordedAt: string;
  /** `null` until Story 3 publishes it. Nothing in this epic's Story 2 writes it. */
  readonly publishedAt: Date | null;
  /** Generated in Story 3. Nothing in this epic's Story 2 writes it. */
  readonly description: string | null;
  /**
   * The series this recording is in, or `null` (Story 6 Ticket 01). Written by
   * {@link setRecordingSeries} in `series.ts` and by nothing else, which is what makes "moving a
   * recording loses nothing" a property of one statement rather than of a convention.
   */
  readonly seriesId: string | null;
  readonly createdAt: Date;
}

export interface NewRecording {
  readonly originalMediaKey: string;
  readonly title: string;
  readonly recordedAt: string;
}

/**
 * Insert a recording.
 *
 * Takes an executor rather than a handle, because finalising an upload writes this row **and**
 * its first job in one transaction: there is no state in which a recording exists and its pipeline
 * never started.
 *
 * **Throws on the unique index if that object is already a recording**, which is deliberately the
 * only thing standing between "finalise twice" and two rows: a `select` here followed by an
 * `insert` has a window in which two requests both find nothing. The caller turns the constraint
 * violation into the refusal a client reads.
 */
export async function insertRecording(
  input: NewRecording,
  executor: Executor = getDatabase(),
): Promise<RecordingRow> {
  const rows = await queryable(executor).insert(recording).values(input).returning();
  const row = rows[0] as RecordingRow | undefined;
  if (!row) throw new Error('insertRecording returned no row');
  return row;
}

/**
 * One recording, or `null`.
 *
 * The worker's way in: a job names a recording and nothing else, so a handler's first question is
 * always "which object is this". `null` rather than a throw, because a job whose recording is gone
 * is a case the handler refuses in its own words.
 */
export async function findRecordingById(
  id: string,
  executor: Executor = getDatabase(),
): Promise<RecordingRow | null> {
  const rows = await queryable(executor)
    .select()
    .from(recording)
    .where(eq(recording.id, id))
    .limit(1);
  return (rows[0] as RecordingRow | undefined) ?? null;
}

/**
 * **There is no plain `listRecordings` here, and that is deliberate.**
 *
 * Story 3 Ticket 04 moved the read to `visibility.ts`, because every list of recordings this
 * product will ever serve has to answer "which of these may this person see" — and a second
 * unfiltered read beside it is the shape in which that rule gets forgotten. The console's list is
 * that same query with the gate open, which is what keeps one answer to "what is most recent" and
 * one answer to "who may see it".
 */

/**
 * Open or close the recording's gate ([3.2.2](docs/project/prd.md),
 * [3.2.11](docs/project/prd.md)).
 *
 * One write of a timestamp, or one write of `null` — which is the whole reason `published_at` is a
 * nullable column rather than a status. **Unpublishing deletes nothing**: the summary, the
 * transcript, the segments, the jobs and the review items are all untouched, so re-publishing is
 * the same write with a timestamp and nothing has to be rebuilt.
 *
 * Publishing a recording that is already published is deliberately **not** a no-op at this level —
 * it re-stamps. The caller is what decides to leave the original timestamp alone, because "when
 * did this go live" is a fact a second press should not quietly move.
 *
 * `null` back means there is no such recording, which the caller turns into `not_found`.
 */
export async function setRecordingPublication(
  id: string,
  publishedAt: Date | null,
  executor: Executor = getDatabase(),
): Promise<RecordingRow | null> {
  const rows = await queryable(executor)
    .update(recording)
    .set({ publishedAt })
    .where(eq(recording.id, id))
    .returning();
  return (rows[0] as RecordingRow | undefined) ?? null;
}

/**
 * Write the description an admin approved ([4.17.1](docs/project/prd.md)).
 *
 * A column on the recording rather than a row of its own, because unlike the summary it has no
 * second gate: it rides the recording's publish state. Approving the `recording_metadata` draft is
 * what calls this, and nothing else does.
 */
export async function setRecordingDescription(
  id: string,
  description: string,
  executor: Executor = getDatabase(),
): Promise<RecordingRow | null> {
  const rows = await queryable(executor)
    .update(recording)
    .set({ description })
    .where(eq(recording.id, id))
    .returning();
  return (rows[0] as RecordingRow | undefined) ?? null;
}

/**
 * Correct what a recording is called and when it was recorded
 * ([3.2.16](docs/project/prd.md)).
 *
 * **Two columns are written and no others.** Not the description, not the summary, not the
 * transcript, not the series, not the publication state — and not `playback_progress`, which is
 * keyed on `(user_id, recording_id)` and appears in no statement here. "Correcting a title loses
 * nothing" is therefore a property of this one `set`, exactly as it is for
 * {@link setRecordingSeries}.
 *
 * The date is a SQL `date` and travels as the `YYYY-MM-DD` string it was written as, so moving a
 * recording in the library's ordering ([3.3.1](docs/project/prd.md)) is this write and nothing
 * else.
 *
 * `null` back means there is no such recording, which the caller turns into `not_found`.
 */
export async function updateRecordingDetails(
  id: string,
  input: RecordingDetails,
  executor: Executor = getDatabase(),
): Promise<RecordingRow | null> {
  const rows = await queryable(executor)
    .update(recording)
    .set({ title: input.title, recordedAt: input.recordedAt })
    .where(eq(recording.id, id))
    .returning();
  return (rows[0] as RecordingRow | undefined) ?? null;
}

/** What an admin may correct after the upload: the two fields they typed at it. */
export interface RecordingDetails {
  readonly title: string;
  /** `YYYY-MM-DD`. */
  readonly recordedAt: string;
}
