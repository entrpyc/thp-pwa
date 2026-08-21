import { sweepRunning, type Executor, type ReclaimedJob } from '@thp/db';
import { withCorrelationId } from '@thp/shared/observability/correlation';
import { logger } from '@thp/shared/observability/logger';

/**
 * What the row says happened. A person reads this in Ticket 04's list beside every other failure,
 * so it says what was true — the worker went away — rather than naming a mechanism.
 */
export const WORKER_RESTART_REASON = 'the worker restarted while this job was running';

/**
 * The assumption the sweep is built on, stated in the log rather than only in a comment.
 *
 * **It is load-bearing.** Every `running` row is treated as abandoned, which is true exactly while
 * one worker process exists. The day somebody scales the worker to two, the second one will reclaim
 * the first's in-flight jobs at boot and both will run the same step — and this line is what makes
 * that discoverable in the log of the run that did it, rather than a mystery about duplicated work.
 */
export const SOLE_WORKER_ASSUMPTION =
  'assuming this is the only worker process: every running job is treated as abandoned';

/**
 * Take back everything the previous run of this process left in flight.
 *
 * Runs once at boot, before any claiming. What it produces is not a retry — a failed job stays
 * failed until a human re-enqueues it (docs/project/prd.md 3.21.2.3) — it is the recovery of jobs
 * nobody is running and nobody will: the old row is failed so the ledger says what happened to it,
 * and a fresh attempt is queued so the recording carries on.
 *
 * **This is where at-least-once comes from.** A worker killed mid-job has that step run again from
 * the beginning on the next boot, so every handler in this epic and every later epic has to be
 * idempotent — it is a property of the dispatch mechanism, not a preference.
 */
export async function sweepAbandonedJobs(executor?: Executor): Promise<ReclaimedJob[]> {
  logger.warn('worker.sweep.start', { assumption: SOLE_WORKER_ASSUMPTION });

  const reclaimed = await sweepRunning(WORKER_RESTART_REASON, executor);

  for (const { failed, requeued } of reclaimed) {
    // Under the id of the request that started it: the sweep has no request of its own, and a
    // reclaimed job is still part of the upload somebody made.
    withCorrelationId(failed.correlationId, () => {
      logger.warn('worker.sweep.reclaimed', {
        jobId: failed.id,
        step: failed.step,
        recordingId: failed.recordingId,
        attempt: failed.attempt,
        requeuedJobId: requeued.id,
        requeuedAttempt: requeued.attempt,
        reason: WORKER_RESTART_REASON,
      });
    });
  }

  logger.info('worker.sweep.finished', { reclaimed: reclaimed.length });
  return reclaimed;
}
