import {
  completeJob,
  enqueueJob,
  failJob,
  withTransaction,
  type Executor,
  type JobRow,
  type ProviderMeta,
} from '@thp/db';
import { PIPELINE_STEPS, nextPipelineStep, type PipelineStep } from '@thp/shared';
import { withCorrelationId } from '@thp/shared/observability/correlation';
import { logger } from '@thp/shared/observability/logger';
import type { HandlerRegistry } from './handlers';

export interface RunJobOptions {
  /** Where the outcome is written. Defaults to the process's pool. */
  readonly executor?: Executor;
  /**
   * The ordered pipeline. The successor of a step that succeeds is read from **this list and
   * nowhere else**, which is what makes inserting a step an edit to one array.
   */
  readonly steps?: readonly PipelineStep[];
}

/**
 * Run one claimed job to a terminal status, and chain forward if it succeeded.
 *
 * **A handler that throws is a failed row, not a crashed worker.** One recording's bad audio is not
 * a reason to stop processing everybody else's, so the failure is recorded and the runner returns
 * normally. What it does *not* swallow is a failure to write the ledger: a worker that cannot
 * record what happened has nothing useful left to do, and the job it was running stays `running`
 * for the startup sweep to reclaim — which is the correct outcome, because nothing about it is
 * known.
 *
 * **Success and the successor are one transaction.** Either the step is succeeded and the next step
 * is queued, or neither happened. A crash between the two would otherwise leave a recording that
 * has finished a step nothing will follow — a pipeline stalled in a state no operator can tell from
 * a pipeline still working.
 *
 * **The correlation id comes off the row** and is carried to the successor, so one upload's whole
 * chain shares the id of the request that started it
 * (core-listening scope tdd § Key choices).
 */
export async function runJob(
  job: JobRow,
  handlers: HandlerRegistry,
  options: RunJobOptions = {},
): Promise<JobRow> {
  const { executor, steps = PIPELINE_STEPS } = options;

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
      // to know *which* step nothing was registered for, and no other column answers that.
      const reason = `no handler is registered for step "${job.step}"`;
      const row = await failJob(job.id, reason, executor);
      logger.error('job.failed', { ...fields, reason });
      return row;
    }

    let providerMeta: ProviderMeta | null;
    try {
      providerMeta = (await handler(job)) ?? null;
    } catch (cause) {
      // The message on the row, the whole error in the log — see MAX_JOB_ERROR_LENGTH.
      const reason = cause instanceof Error ? cause.message : String(cause);
      const row = await failJob(job.id, reason, executor);
      // **The chain stops here.** A failed step enqueues nothing, which is what turns
      // docs/project/prd.md 3.21.2.3's "halt and flag" into a property of the mechanism rather than
      // a rule each handler has to remember.
      logger.error('job.failed', { ...fields, reason, error: describeError(cause) });
      return row;
    }

    const next = nextPipelineStep(job.step, steps);
    const row = await withTransaction(async (tx) => {
      const completed = await completeJob(job.id, providerMeta, tx);
      if (next !== null) {
        // A no-op when the successor is already pending or running — the partial unique index says
        // so, and `enqueueJob` reads the existing row back rather than failing.
        await enqueueJob(
          { recordingId: job.recordingId, step: next, correlationId: job.correlationId },
          tx,
        );
      }
      return completed;
    }, executor);

    logger.info('job.succeeded', { ...fields, next });
    return row;
  });
}

/** The stack when there is one, so the row's truncated message is not the only record. */
function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.stack ?? `${cause.name}: ${cause.message}`;
  return String(cause);
}
