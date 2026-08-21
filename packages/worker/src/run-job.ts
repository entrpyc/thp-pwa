import { completeJob, failJob, type DatabaseHandle, type JobRow } from '@thp/db';
import { withCorrelationId } from '@thp/shared/observability/correlation';
import { logger } from '@thp/shared/observability/logger';
import type { HandlerRegistry } from './handlers';

/**
 * Run one claimed job to a terminal status.
 *
 * **This function never throws for a job that failed.** A handler that throws is a failed row and a
 * logged line, not a crashed worker — the loop above it must keep polling, because one recording's
 * bad audio is not a reason to stop processing everybody else's. What it *can* still throw is a
 * database failure while recording the outcome, and that is deliberately not swallowed: a worker
 * that cannot write the ledger has nothing useful left to do.
 *
 * **The correlation id comes off the row.** The worker has no request behind it, so the id that
 * spans API request → job → provider call cannot be inherited from an async frame — it travelled
 * here as a column (docs/epics/epic-core-listening/architecture.md § Key choices). Entering it here
 * is what makes every line this job emits, including the handler's own, quotable against the
 * upload that caused it.
 */
export async function runJob(
  job: JobRow,
  handlers: HandlerRegistry,
  handle?: DatabaseHandle,
): Promise<JobRow> {
  return withCorrelationId(job.correlationId, async () => {
    const fields = {
      jobId: job.id,
      step: job.step,
      recordingId: job.recordingId,
      attempt: job.attempt,
    };

    const handler = handlers[job.step];
    if (!handler) {
      // Naming the step rather than saying "unknown handler": the operator reading this row needs
      // to know *which* step nothing was registered for, and the answer is not on any other column
      // once a second worker build with a different registry exists.
      const reason = `no handler is registered for step "${job.step}"`;
      const row = await failJob(job.id, reason, handle);
      logger.error('job.failed', { ...fields, reason });
      return row;
    }

    try {
      const providerMeta = (await handler(job)) ?? null;
      const row = await completeJob(job.id, providerMeta, handle);
      logger.info('job.succeeded', fields);
      return row;
    } catch (cause) {
      // The message on the row, the whole error in the log — see MAX_JOB_ERROR_LENGTH.
      const reason = cause instanceof Error ? cause.message : String(cause);
      const row = await failJob(job.id, reason, handle);
      logger.error('job.failed', { ...fields, reason, error: describeError(cause) });
      return row;
    }
  });
}

/** The stack when there is one, so the row's truncated message is not the only record. */
function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.stack ?? `${cause.name}: ${cause.message}`;
  return String(cause);
}
