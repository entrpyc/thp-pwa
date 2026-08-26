import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { UNFINISHED_JOB_STATUSES, type JobStatus, type PipelineStep } from '@thp/shared';
import { getDatabase, queryable, withTransaction, type Executor } from './client';
import { job } from './schema';

/**
 * The job ledger's queries. **Query construction lives here and nowhere else** — the
 * import-boundary guard refuses a `drizzle-orm` import from `packages/web`, and
 * tools/queue-boundary.ts refuses an import of anything in this module from anywhere in
 * `packages/web` but the queue adapter. So "the API enqueues through one door" is enforced rather
 * than intended.
 *
 * The ledger is the queue: there is no broker and no second store
 * (project tdd 4.7). And it is **append-only** — a step that
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
  /** What this run was asked for. `null` on every chained job — see the column. */
  readonly payload: unknown;
}

export interface NewJob {
  readonly recordingId: string;
  readonly step: PipelineStep;
  readonly correlationId: string;
  /**
   * Optional, and absent everywhere but a steered regeneration (Story 3 Ticket 03). The chain
   * enqueues its successor without one, which is what leaves the chain rule untouched.
   */
  readonly payload?: unknown;
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
  executor: Executor = getDatabase(),
): Promise<JobRow> {
  const nextAttempt = sql<number>`(
    select coalesce(max(${job.attempt}), 0) + 1 from ${job}
    where ${and(eq(job.recordingId, input.recordingId), eq(job.step, input.step))}
  )`;

  const inserted = await queryable(executor)
    .insert(job)
    .values({
      recordingId: input.recordingId,
      step: input.step,
      status: 'pending',
      attempt: nextAttempt,
      correlationId: input.correlationId,
      payload: input.payload ?? null,
    })
    .onConflictDoNothing()
    .returning();

  const row = inserted[0] as JobRow | undefined;
  if (row) return row;

  // Refused by the partial unique index: this step is already pending or running for this
  // recording, and *that* row is the answer.
  const existing = await findUnfinishedJob(input.recordingId, input.step, executor);
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
  executor: Executor = getDatabase(),
): Promise<JobRow | null> {
  const rows = await queryable(executor)
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
  executor: Executor = getDatabase(),
): Promise<JobRow> {
  const rows = await queryable(executor)
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
  executor: Executor = getDatabase(),
): Promise<JobRow> {
  const rows = await queryable(executor)
    .update(job)
    .set({ status: 'failed', finishedAt: sql`now()`, error: reason.slice(0, MAX_JOB_ERROR_LENGTH) })
    .where(eq(job.id, id))
    .returning();

  const row = rows[0] as JobRow | undefined;
  if (!row) throw new Error(`failJob: no job ${id}`);
  return row;
}

/** A job the sweep took back: the row it failed, and the fresh attempt it queued in its place. */
export interface ReclaimedJob {
  readonly failed: JobRow;
  readonly requeued: JobRow;
}

/**
 * Fail every `running` job and queue a fresh attempt of each — **crash recovery, not retry.**
 *
 * A job is `running` because a worker claimed it and has not finished it. At boot there is no such
 * worker, so every one of those rows is abandoned by definition: the process that owned it is gone,
 * and nothing else will ever finish it. Left alone it would sit `running` forever, and the
 * recording behind it would be stuck with no failure to show for it.
 *
 * **Correct only while exactly one worker process runs.** A second worker booting would reclaim the
 * first's jobs mid-flight — from this function's point of view an in-flight job and an abandoned one
 * are the same row. The deployment pins concurrency to 1
 * (project tdd 8.2); the caller logs that it assumes it.
 *
 * Fail-then-enqueue, in one transaction and in that order. The order is what keeps the partial
 * unique index satisfied — the old row stops being unfinished before the new one starts. The
 * transaction is what stops a half-swept ledger, where a job is failed and nothing was queued to
 * replace it.
 *
 * This is the **one** automatic re-enqueue in the epic. A job that failed on its own merits stays
 * failed until a human re-enqueues the step (docs/project/prd.md 3.21.2.3).
 */
export async function sweepRunning(
  reason: string,
  executor: Executor = getDatabase(),
): Promise<ReclaimedJob[]> {
  return withTransaction(async (tx) => {
    const abandoned = (await queryable(tx)
      .select()
      .from(job)
      .where(eq(job.status, 'running'))
      .orderBy(asc(job.enqueuedAt), asc(job.id))) as JobRow[];

    const reclaimed: ReclaimedJob[] = [];
    for (const row of abandoned) {
      const failed = await failJob(row.id, reason, tx);
      const requeued = await enqueueJob(
        { recordingId: row.recordingId, step: row.step, correlationId: row.correlationId },
        tx,
      );
      reclaimed.push({ failed, requeued });
    }
    return reclaimed;
  }, executor);
}

/**
 * Claim the oldest waiting job: mark it `running`, stamp `started_at`, and hand it back.
 *
 * **One statement.** The row is selected, locked, and changed in a single
 * `update … where id = (select … for update skip locked limit 1) returning *`, so there is no
 * window between "this job is mine" and "this job says it is mine" for a second worker to look into.
 * A claim in two statements would need a transaction around it and would still be the same query
 * written less honestly.
 *
 * **`skip locked`, not `nowait` and not waiting.** A row another transaction holds is *passed over*
 * rather than waited for, so two workers polling at the same moment take different jobs instead of
 * queueing behind one. It is also what makes the empty answer meaningful: nothing came back because
 * nothing is available *to me*, which is the same thing as far as the caller is concerned.
 *
 * Oldest first, `enqueued_at` ascending with `id` as the tiebreak — for the same reason
 * the recordings list breaks its tie: two rows written in the same millisecond would otherwise come
 * back in whatever order the planner chose that second.
 *
 * `null` when the queue is empty, which is not an error. It is what a worker sees most of the time.
 */
export async function claimNextJob(executor: Executor = getDatabase()): Promise<JobRow | null> {
  const on = queryable(executor);

  const oldestWaiting = on
    .select({ id: job.id })
    .from(job)
    .where(eq(job.status, 'pending'))
    .orderBy(asc(job.enqueuedAt), asc(job.id))
    .limit(1)
    .for('update', { skipLocked: true });

  const rows = await on
    .update(job)
    .set({ status: 'running', startedAt: sql`now()` })
    .where(eq(job.id, sql`(${oldestWaiting})`))
    .returning();

  return (rows[0] as JobRow | undefined) ?? null;
}
