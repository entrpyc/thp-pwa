import type { PipelineStep } from '@thp/shared';
import { currentCorrelationId, resolveCorrelationId } from '@/server/observability/correlation';
import { buildQueue } from './postgres-queue';

/**
 * **The work queue, as the API is allowed to see it.**
 *
 * One port, one adapter behind it — the same shape as the media store and the mailer, and enforced
 * the same way: tools/queue-boundary.ts fails the build if anything in `packages/web` outside
 * `postgres-queue.ts` reaches the ledger's queries. A second door would be one that does not carry
 * the request's correlation id, does not go through the partial unique index's no-op, and does not
 * compute `attempt` inside the insert.
 *
 * The port is the seam docs/epics/epic-core-listening/architecture.md § Extension points names as
 * *Queue port*: the day the ledger is not enough, a broker arrives as a second adapter and nothing
 * that calls `enqueue` changes. Nothing in this epic anticipates that further.
 *
 * **It wraps only the enqueue half.** The API dispatches work and never claims it; the worker
 * claims, runs and completes, in its own process, against `@thp/db` directly. A port covering both
 * would be a port whose second half has exactly one caller that is not in this package.
 */

/** What came back from an enqueue — the row as the API has any business knowing it. */
export interface EnqueuedJob {
  readonly id: string;
  readonly recordingId: string;
  readonly step: PipelineStep;
  /** 1 for the first run of this step, higher for a re-run. */
  readonly attempt: number;
  readonly correlationId: string;
}

export interface EnqueueRequest {
  readonly recordingId: string;
  readonly step: PipelineStep;
  /**
   * Defaults to the correlation id of the request in flight, which is what a caller inside a route
   * always wants — the id is read from the same store the logger reads it from, so a job and the
   * request that caused it are one query apart. Passed explicitly only outside a request.
   */
  readonly correlationId?: string;
}

export interface Queue {
  /** Which adapter is in use, for the log line. Never a vendor decision made in code. */
  readonly name: string;

  /**
   * Enqueue a step, or hand back the job already in flight for that recording and step.
   *
   * **Enqueuing twice is a no-op, not an error** — the second call returns the first call's job.
   * The rule is the database's (a partial unique index over `(recording_id, step)` while
   * unfinished), not this interface's, so it holds however the row was written.
   */
  enqueue(input: EnqueueRequest): Promise<EnqueuedJob>;
}

/**
 * The id to stamp on the row: the request's, or a fresh one when there is no request — a job
 * enqueued outside a request is still a job somebody has to be able to trace.
 */
export function correlationIdForJob(explicit: string | undefined): string {
  return explicit ?? currentCorrelationId() ?? resolveCorrelationId(null);
}

let instance: Queue | undefined;

/** The queue, built once and cached — the same reason the media store and the mailer are. */
export function queue(): Queue {
  instance ??= buildQueue();
  return instance;
}
