import { desc, eq } from 'drizzle-orm';
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
 * Every recording, **newest `recorded_at` first** — the order the admin list is read in, decided
 * here rather than in the client so one answer to "what is most recent" exists.
 *
 * `created_at` breaks the tie, because a `date` has no time of day and two teachings recorded on
 * the same Sunday would otherwise come back in whatever order the planner chose that second.
 */
export async function listRecordings(
  executor: Executor = getDatabase(),
): Promise<RecordingRow[]> {
  const rows = await queryable(executor)
    .select()
    .from(recording)
    .orderBy(desc(recording.recordedAt), desc(recording.createdAt));
  return rows as RecordingRow[];
}
