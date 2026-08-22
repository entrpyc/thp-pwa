import { enqueueJob, findUnfinishedJob, type Executor } from '@thp/db';
import type { PipelineStep } from '@thp/shared';
import { correlationIdForJob, type EnqueueRequest, type EnqueuedJob, type Queue } from './queue';

/**
 * **The one file in `packages/web` allowed to reach the job ledger.**
 *
 * tools/queue-boundary.ts names this path and refuses an import of any of `@thp/db`'s ledger
 * queries from anywhere else under `packages/web/src`. Query construction itself is not here — it
 * is in `@thp/db`, as the import-boundary guard already requires — so what this adapter actually
 * does is small on purpose: resolve the correlation id, call the ledger, and narrow the row to what
 * the port declares.
 *
 * "Postgres" is the name because the ledger *is* the queue
 * (docs/project/architecture.md § Key technology choices). A broker would be a sibling of this
 * file, not an edit to it.
 */
export function buildQueue(): Queue {
  return {
    name: 'postgres',

    async enqueue(input: EnqueueRequest, executor?: Executor): Promise<EnqueuedJob> {
      const row = await enqueueJob(
        {
          recordingId: input.recordingId,
          step: input.step,
          correlationId: correlationIdForJob(input.correlationId),
          payload: input.payload,
        },
        // `undefined` here means "the process's pool", which is what the ledger's default says.
        executor,
      );

      return narrow(row);
    },

    async findUnfinished(
      recordingId: string,
      step: PipelineStep,
    ): Promise<EnqueuedJob | null> {
      const row = await findUnfinishedJob(recordingId, step);
      return row === null ? null : narrow(row);
    },
  };
}

/** The ledger's row, narrowed to what the port declares. */
function narrow(row: {
  readonly id: string;
  readonly recordingId: string;
  readonly step: PipelineStep;
  readonly attempt: number;
  readonly correlationId: string;
}): EnqueuedJob {
  return {
    id: row.id,
    recordingId: row.recordingId,
    step: row.step,
    attempt: row.attempt,
    correlationId: row.correlationId,
  };
}
