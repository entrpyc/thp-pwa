import { claimNextJob, type Executor } from '@thp/db';
import { PIPELINE_STEPS, type PipelineStep } from '@thp/shared';
import { withCorrelationId } from '@thp/shared/observability/correlation';
import { logger } from '@thp/shared/observability/logger';
import { createHandlers, type HandlerRegistry } from './handlers';
import { runJob } from './run-job';

/**
 * Two seconds, in code rather than in the environment.
 *
 * Dispatch latency is invisible at ~4.3 recordings a month
 * (core-listening scope tdd § Key choices), so the number does not need to be
 * tunable per deployment — and a knob nobody has a reason to turn is a knob somebody eventually
 * turns for a reason nobody records. The loop takes it as an argument so tests can drive it fast.
 */
export const POLL_INTERVAL_MS = 2_000;

export interface WorkerLoopOptions {
  /** The steps this worker knows how to run. Defaults to the configured ones. */
  readonly handlers?: HandlerRegistry;
  /** The ordered pipeline the chain rule reads. */
  readonly steps?: readonly PipelineStep[];
  readonly executor?: Executor;
  readonly pollIntervalMs?: number;
}

export interface WorkerLoop {
  /** Resolves when the loop has stopped **and** the job in flight has reached a terminal status. */
  readonly done: Promise<void>;
  /** Stop claiming. A job already running is finished first; nothing new is taken. */
  stop(): void;
}

/**
 * The worker loop: claim a job, run it, claim the next one, and poll when there is nothing.
 *
 * **One job at a time**, because the loop awaits each run before claiming again. Concurrency is
 * pinned to 1 by the shape of this function rather than by a setting — the deployment is one small
 * process (project tdd 8.1), and a pool would be a second
 * thing to reason about for a queue that is empty almost always.
 *
 * **It polls; nothing wakes it.** No `LISTEN`/`NOTIFY`, no broker — seconds of latency cost nothing
 * at this volume, and the ledger stays the only moving part.
 *
 * **An empty queue is the normal case**, not an error and not a reason to stop. Neither is a
 * failing job: `runJob` records the failure and returns. What this loop does catch is a failure of
 * the *ledger itself* — the claim or the outcome write — and it logs it and carries on rather than
 * exiting, because nothing restarts this process in this epic (supervision is Story 7) and a worker
 * that dies on a transient database blip stops processing everybody's uploads. A job left `running`
 * by such a failure is recovered by the sweep at the next restart.
 */
export function startWorkerLoop(options: WorkerLoopOptions = {}): WorkerLoop {
  const {
    handlers = createHandlers(),
    steps = PIPELINE_STEPS,
    executor,
    pollIntervalMs = POLL_INTERVAL_MS,
  } = options;

  let stopped = false;
  /** Set while the loop is sleeping, so `stop` cuts the wait short instead of outliving it. */
  let wake: (() => void) | null = null;

  function stop(): void {
    stopped = true;
    wake?.();
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      wake = finish;
    });
  }

  // Spread rather than passed as `{ executor }`: with `exactOptionalPropertyTypes`, an absent
  // executor and one explicitly set to `undefined` are different types, and only the first means
  // "use the process's pool".
  const runOptions = { steps, ...(executor === undefined ? {} : { executor }) };

  async function loop(): Promise<void> {
    logger.info('worker.started', { pollIntervalMs, steps: [...steps] });

    while (!stopped) {
      let claimed;
      try {
        claimed = await claimNextJob(executor);
      } catch (cause) {
        logger.error('worker.claim.failed', { error: describeError(cause) });
        await sleep(pollIntervalMs);
        continue;
      }

      if (!claimed) {
        await sleep(pollIntervalMs);
        continue;
      }

      const job = claimed;
      withCorrelationId(job.correlationId, () => {
        logger.info('job.claimed', {
          jobId: job.id,
          step: job.step,
          recordingId: job.recordingId,
          attempt: job.attempt,
        });
      });

      try {
        await runJob(job, handlers, runOptions);
        // Straight back to the top: a queue with work in it is drained, not polled through.
        continue;
      } catch (cause) {
        // The ledger refused the outcome. The job stays `running` and the sweep takes it back at
        // the next boot; nothing here can improve on that.
        logger.error('worker.run.failed', { jobId: job.id, error: describeError(cause) });
        await sleep(pollIntervalMs);
      }
    }

    logger.info('worker.stopped', {});
  }

  return { done: loop(), stop };
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.stack ?? `${cause.name}: ${cause.message}`;
  return String(cause);
}
