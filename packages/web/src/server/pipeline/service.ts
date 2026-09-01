import {
  countEditedChaptersByRecording,
  findRecordingById,
  readPipeline,
  type PipelineStepRow,
} from '@thp/db';
import {
  NOT_STARTED,
  isPipelineStep,
  isStubProviderMeta,
  type PipelineListPayload,
  type PipelineStepView,
  type RerunPayload,
  type RerunRequest,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { queue } from '@/server/jobs/queue';
import { logger } from '@/server/observability/logger';

/**
 * **What the pipeline is doing, and the one control over it.**
 *
 * Two halves that go different ways on purpose:
 *
 * 1. **The read goes straight to `@thp/db`'s pipeline module**, not through the queue port.
 *    core-listening scope tdd § Extension points promises that a broker
 *    arriving leaves "the ledger and the dashboard query untouched", so the dashboard query is not
 *    a dispatch concern and wrapping it in the port would be inventing one.
 * 2. **The re-run goes through the port**, like every other enqueue in this package — so the row
 *    carries the request's correlation id, computes `attempt` inside the insert, and treats a step
 *    already in flight as a no-op rather than as a conflict.
 *
 * There is no precondition on a re-run. Running `generate_draft` for a recording whose `transcribe`
 * failed is not a mistake to guard against — it is docs/project/prd.md 3.5.8's escape hatch, the
 * admin having read a low-confidence transcript and judged it usable. And the chain rule stands:
 * re-running `transcribe` re-runs `generate_draft` behind it on success, because a fresh transcript
 * makes the existing draft wrong. 3.21.2.4's "without re-running the whole pipeline" is satisfied
 * by being able to start anywhere, not by severing the chain.
 */

/**
 * Every recording's pipeline, in the order the query returned it — newest recorded first, never
 * re-sorted here or on the client.
 */
export async function readPipelineStatus(actor: Actor): Promise<PipelineListPayload> {
  /*
   * Two reads, in parallel, because the second answers a different question about the same rows:
   * how much human work re-running `generate_chapters` would discard
   * ([3.22.8](docs/project/prd.md)). One grouped count for the whole library rather than one per
   * teaching — the confirmation needs a number per row, and asking per row would be a query per
   * teaching for a sentence nobody has pressed towards yet.
   */
  const [rows, edited] = await Promise.all([readPipeline(), countEditedChaptersByRecording()]);

  logger.info('pipeline.read', {
    actorId: actor.id,
    action: 'pipeline.read',
    target: 'recording:*',
    count: rows.length,
  });

  return {
    recordings: rows.map((row) => ({
      recordingId: row.recordingId,
      title: row.title,
      recordedAt: row.recordedAt,
      steps: row.steps.map(describeStep),
      // A teaching with no edited chapters is absent from the map, and a missing key reads as none
      // — which is what it is.
      editedChapters: edited.get(row.recordingId) ?? 0,
    })),
  };
}

/**
 * Run one step of one recording again.
 *
 * Answers with the job that is now waiting — which, when a job for that pair was **already**
 * unfinished, is that job. Pressing twice is harmless because the partial unique index refused the
 * second row and `enqueueJob` read the first one back; the API does not invent a conflict the
 * database already resolved.
 */
export async function rerunStep(
  actor: Actor,
  recordingId: string,
  body: unknown,
): Promise<RerunPayload> {
  const step = parseRerunRequest(body);

  // Asked before anything is written, so a re-run for a recording that is not there answers
  // `not_found` rather than failing on a foreign key.
  const recording = await findRecordingById(recordingId);
  if (recording === null) {
    throw ApiError.notFound('There is no recording with that id.');
  }

  const enqueued = await queue().enqueue({ recordingId, step });

  logger.info('pipeline.rerun', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'pipeline.rerun',
    target: `recording:${recordingId}`,
    step,
    jobId: enqueued.id,
    attempt: enqueued.attempt,
  });

  return {
    jobId: enqueued.id,
    recordingId: enqueued.recordingId,
    step: enqueued.step,
    attempt: enqueued.attempt,
  };
}

/**
 * The ledger's row, as the screen is allowed to see it.
 *
 * A step with no row has never been enqueued, and reads as `not_started` rather than being absent —
 * so the screen has one cell per step of the chain whatever the chain is. `provider_meta` does not
 * cross the wire: what the screen needs from it is the one question "was this a stub", and the
 * answer is a boolean.
 */
function describeStep(row: PipelineStepRow): PipelineStepView {
  return {
    step: row.step,
    status: row.status ?? NOT_STARTED,
    attempt: row.attempt,
    error: row.error,
    enqueuedAt: row.enqueuedAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    stub: row.status === 'succeeded' && isStubProviderMeta(row.providerMeta),
  };
}

function parseRerunRequest(body: unknown): RerunRequest['step'] {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object naming the step to run again.');
  }
  const { step } = body as Partial<RerunRequest>;
  if (!isPipelineStep(step)) {
    throw ApiError.invalidInput('That is not a step of this pipeline.');
  }
  return step;
}
