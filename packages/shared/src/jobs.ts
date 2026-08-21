/**
 * The job ledger's vocabulary (Story 2 Ticket 02).
 *
 * The four statuses a row in the `job` table can hold, stated once here so the Postgres enum, the
 * API that enqueues and the worker that claims cannot drift apart — the database layer derives its
 * `pgEnum` from this tuple rather than restating it, and tests/guards/domain-declarations.test.ts
 * fails a second declaration of either name.
 *
 * The set is deliberately small and deliberately terminal. There is no `retrying`, because there is
 * no automatic retry — docs/project/prd.md 3.21.2.3 asks the pipeline to halt and flag, and a
 * failure stays failed until a human re-enqueues the step. There is no `cancelled`, because nothing
 * can stop a claimed job. Both are absent rather than unused: a status nothing writes is a status
 * somebody eventually reads as meaningful.
 */
export const JOB_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}

/**
 * The statuses that mean a job is still in flight — waiting to be claimed, or claimed and running.
 *
 * This is the predicate the partial unique index over `(recording_id, step)` is built on, and
 * therefore the definition of "a recording has at most one unfinished job per step". The ledger is
 * append-only — every run of a step is its own row — so uniqueness cannot be over the pair itself;
 * what must be unique is the pair *while it is unfinished*. That is what makes an admin
 * double-clicking a re-run harmless.
 */
export const UNFINISHED_JOB_STATUSES: readonly JobStatus[] = ['pending', 'running'];

export function isUnfinishedJobStatus(value: JobStatus): boolean {
  return UNFINISHED_JOB_STATUSES.includes(value);
}
