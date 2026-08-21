import { and, eq, inArray, sql } from 'drizzle-orm';
import { UNFINISHED_JOB_STATUSES, type JobStatus, type PipelineStep } from '@thp/shared';
import { getDatabase, type DatabaseHandle } from './client';
import { job } from './schema';

/**
 * The job ledger's queries. **Query construction lives here and nowhere else** — the
 * import-boundary guard refuses a `drizzle-orm` import from `packages/web`, and
 * tools/queue-boundary.ts refuses an import of anything in this module from anywhere in
 * `packages/web` but the queue adapter. So "the API enqueues through one door" is enforced rather
 * than intended.
 *
 * The ledger is the queue: there is no broker and no second store
 * (docs/project/architecture.md § Key technology choices). And it is **append-only** — a step that
 * runs again is a new row, not a status reset — which is what makes `attempt` a count rather than
 * a flag and what makes the uniqueness rule a *partial* one.
 */

export interface JobRow {
  readonly id: string;
  readonly recordingId: string;
  readonly step: PipelineStep;
  readonly status: JobStatus;
  /** 1 for the first run of this `(recording_id, step)` pair, one higher for each run after. */
  readonly attempt: number;
  readonly error: string | null;
  /** The request that caused this job, carried across the process boundary on the row. */
  readonly correlationId: string;
  readonly enqueuedAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly providerMeta: unknown;
}

export interface NewJob {
  readonly recordingId: string;
  readonly step: PipelineStep;
  readonly correlationId: string;
}

/**
 * Enqueue a step for a recording, or hand back the one already in flight.
 *
 * Two properties, both held by the database rather than by a caller remembering:
 *
 * 1. **`attempt` is computed inside the insert**, as `max(attempt) + 1` over the pair's existing
 *    rows, so no two enqueues can read the same number and agree on it. A read-then-write would
 *    have a window in which two callers both see 1.
 * 2. **Enqueuing a step that is already pending or running is a no-op**, not an error. The partial
 *    unique index is what refuses the second row; `on conflict do nothing` is what turns that
 *    refusal into "you already have one", and the row that comes back is the existing job. That is
 *    what makes an admin double-clicking Ticket 04's re-run harmless.
 *
 * The pair races: two concurrent enqueues both compute the same `attempt`, one wins the index and
 * the other reads the winner's row. Which is the correct answer for both of them.
 */
export async function enqueueJob(
  input: NewJob,
  handle: DatabaseHandle = getDatabase(),
): Promise<JobRow> {
  const nextAttempt = sql<number>`(
    select coalesce(max(${job.attempt}), 0) + 1 from ${job}
    where ${and(eq(job.recordingId, input.recordingId), eq(job.step, input.step))}
  )`;

  const inserted = await handle.db
    .insert(job)
    .values({
      recordingId: input.recordingId,
      step: input.step,
      status: 'pending',
      attempt: nextAttempt,
      correlationId: input.correlationId,
    })
    .onConflictDoNothing()
    .returning();

  const row = inserted[0] as JobRow | undefined;
  if (row) return row;

  // Refused by the partial unique index: this step is already pending or running for this
  // recording, and *that* row is the answer.
  const existing = await findUnfinishedJob(input.recordingId, input.step, handle);
  if (existing) return existing;

  // Reachable only if the conflicting job finished between the insert and this read, which leaves
  // the step genuinely un-enqueued. Stated rather than silently swallowed; the caller retries.
  throw new Error(
    `enqueueJob: ${input.step} for recording ${input.recordingId} was refused by a job that has since finished`,
  );
}

/** The pending or running job for this pair, if there is one. There can never be two. */
export async function findUnfinishedJob(
  recordingId: string,
  step: PipelineStep,
  handle: DatabaseHandle = getDatabase(),
): Promise<JobRow | null> {
  const rows = await handle.db
    .select()
    .from(job)
    .where(
      and(
        eq(job.recordingId, recordingId),
        eq(job.step, step),
        inArray(job.status, [...UNFINISHED_JOB_STATUSES]),
      ),
    )
    .limit(1);
  return (rows[0] as JobRow | undefined) ?? null;
}

/**
 * The most of a failure the row will hold, in characters.
 *
 * A cap rather than the whole thing, because `error` is read in a list beside every other job: a
 * provider that answers a failure with a page of stack trace would otherwise bloat the row and the
 * view over it. **The full error is in the log line**, under the same correlation id — this column
 * is the reason, not the record.
 */
export const MAX_JOB_ERROR_LENGTH = 2000;

/** What a handler wants recorded about how it ran. Shape is the provider's, not ours. */
export type ProviderMeta = Record<string, unknown>;

/**
 * Mark a job succeeded, stamp `finished_at`, and record what the handler reported.
 *
 * `error` is set to null rather than left alone: a job that succeeded on a second attempt is a
 * different row from the one that failed, but a row that says both would be a row nobody can read.
 */
export async function completeJob(
  id: string,
  providerMeta: ProviderMeta | null = null,
  handle: DatabaseHandle = getDatabase(),
): Promise<JobRow> {
  const rows = await handle.db
    .update(job)
    .set({ status: 'succeeded', finishedAt: sql`now()`, error: null, providerMeta })
    .where(eq(job.id, id))
    .returning();

  const row = rows[0] as JobRow | undefined;
  if (!row) throw new Error(`completeJob: no job ${id}`);
  return row;
}

/**
 * Mark a job failed, stamp `finished_at`, and record why.
 *
 * **Terminal.** There is no retry and no backoff: docs/project/prd.md 3.21.2.3 asks the pipeline to
 * halt and flag, and the row stays failed until a human re-enqueues the step. Truncation happens
 * here rather than at the call site so every writer of this column obeys the same cap.
 */
export async function failJob(
  id: string,
  reason: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<JobRow> {
  const rows = await handle.db
    .update(job)
    .set({ status: 'failed', finishedAt: sql`now()`, error: reason.slice(0, MAX_JOB_ERROR_LENGTH) })
    .where(eq(job.id, id))
    .returning();

  const row = rows[0] as JobRow | undefined;
  if (!row) throw new Error(`failJob: no job ${id}`);
  return row;
}
