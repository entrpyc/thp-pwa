import { desc, eq } from 'drizzle-orm';
import { PIPELINE_STEPS, type JobStatus, type PipelineStep } from '@thp/shared';
import { getDatabase, queryable, type Executor } from './client';
import { job, recording } from './schema';

/**
 * **What the pipeline is doing to every recording, in one query.**
 *
 * docs/project/prd.md 3.19.4 asks an admin to be able to read the state of every step of every
 * recording, and docs/epics/epic-core-listening/architecture.md § Job ledger is explicit that the
 * ledger being *queryable pipeline state* is half of why it lives in Postgres rather than behind a
 * broker. This module is that read.
 *
 * **Deliberately not behind the queue port.** The extension-points row promises that a broker
 * arriving leaves "the ledger and the dashboard query untouched" — so the dashboard query is not a
 * dispatch concern, and a web service module calls it directly. `packages/web`'s queue adapter
 * keeps wrapping the enqueue half alone, and tools/queue-boundary.ts stays satisfied because it
 * derives its forbidden names from the exports of `jobs.ts` and nothing here is one of them.
 *
 * **The answer is the latest attempt of each step, not an aggregate over its history.** The ledger
 * is append-only — a re-run is a new row — so "the status of `transcribe` for this recording" is
 * the row with the highest `attempt` for the pair. Every older attempt stays in the table; nothing
 * here reads them, which is what "the screen shows the latest attempt and nothing older" means.
 */

/** One step of one recording. `status` is `null` when the step has never been enqueued. */
export interface PipelineStepRow {
  readonly step: PipelineStep;
  readonly status: JobStatus | null;
  readonly attempt: number | null;
  readonly error: string | null;
  readonly enqueuedAt: Date | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  /** What the handler recorded about how it ran. Null at enqueue, and for a step never enqueued. */
  readonly providerMeta: unknown;
}

/** One recording and every step of the chain, in the chain's order. */
export interface RecordingPipelineRow {
  readonly recordingId: string;
  readonly title: string;
  /** `YYYY-MM-DD`. A SQL `date`, so it comes back as the string it was written as. */
  readonly recordedAt: string;
  readonly steps: readonly PipelineStepRow[];
}

/** The shape the join comes back in — one row per (recording, latest job), or a recording alone. */
interface JoinedRow {
  readonly recordingId: string;
  readonly title: string;
  readonly recordedAt: string;
  readonly step: PipelineStep | null;
  readonly status: JobStatus | null;
  readonly attempt: number | null;
  readonly error: string | null;
  readonly enqueuedAt: Date | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly providerMeta: unknown;
}

/**
 * Every recording's pipeline, **newest `recorded_at` first** — the same order the recordings list
 * is in, so the console has one answer to "what is most recent" rather than two.
 *
 * One statement: a left join from `recording` onto a `distinct on (recording_id, step)` of the
 * ledger ordered by descending `attempt`, which is Postgres saying "the latest attempt of each
 * pair" in the one place that can say it without a second round trip. The join is *left* because a
 * recording with no jobs at all is still a recording an operator has to be able to see — a
 * finalisation whose enqueue never happened would otherwise be invisible on the one screen that
 * exists to make the pipeline visible.
 *
 * The step list comes from `PIPELINE_STEPS`, so the answer has one entry per step of the chain
 * however long the chain becomes — a step nothing has enqueued reads as *not started* rather than
 * being absent, and `process_audio` arriving is a column the screen grows on its own.
 */
export async function readPipeline(
  executor: Executor = getDatabase(),
): Promise<RecordingPipelineRow[]> {
  const on = queryable(executor);

  const latest = on
    .selectDistinctOn([job.recordingId, job.step], {
      recordingId: job.recordingId,
      step: job.step,
      status: job.status,
      attempt: job.attempt,
      error: job.error,
      enqueuedAt: job.enqueuedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      providerMeta: job.providerMeta,
    })
    .from(job)
    .orderBy(job.recordingId, job.step, desc(job.attempt))
    .as('latest');

  const rows = (await on
    .select({
      recordingId: recording.id,
      title: recording.title,
      recordedAt: recording.recordedAt,
      step: latest.step,
      status: latest.status,
      attempt: latest.attempt,
      error: latest.error,
      enqueuedAt: latest.enqueuedAt,
      startedAt: latest.startedAt,
      finishedAt: latest.finishedAt,
      providerMeta: latest.providerMeta,
    })
    .from(recording)
    .leftJoin(latest, eq(latest.recordingId, recording.id))
    // `created_at` breaks the tie for the same reason `listRecordings` uses it: a `date` has no
    // time of day, and two teachings recorded on the same Sunday would otherwise come back in
    // whatever order the planner chose that second.
    .orderBy(desc(recording.recordedAt), desc(recording.createdAt))) as unknown as JoinedRow[];

  return assemble(rows);
}

/**
 * The join's rows, folded into one entry per recording with one entry per step inside it.
 *
 * Order is preserved from the query rather than re-derived, so "the client does not re-sort" has
 * something to be true of.
 */
function assemble(rows: readonly JoinedRow[]): RecordingPipelineRow[] {
  const byRecording = new Map<string, { row: JoinedRow; jobs: Map<PipelineStep, JoinedRow> }>();

  for (const row of rows) {
    const found = byRecording.get(row.recordingId) ?? { row, jobs: new Map() };
    if (row.step !== null) found.jobs.set(row.step, row);
    byRecording.set(row.recordingId, found);
  }

  return [...byRecording.values()].map(({ row, jobs }) => ({
    recordingId: row.recordingId,
    title: row.title,
    recordedAt: row.recordedAt,
    steps: PIPELINE_STEPS.map((step) => {
      const found = jobs.get(step);
      if (!found) {
        return {
          step,
          status: null,
          attempt: null,
          error: null,
          enqueuedAt: null,
          startedAt: null,
          finishedAt: null,
          providerMeta: null,
        };
      }
      return {
        step,
        status: found.status,
        attempt: found.attempt,
        error: found.error,
        enqueuedAt: found.enqueuedAt,
        startedAt: found.startedAt,
        finishedAt: found.finishedAt,
        providerMeta: found.providerMeta,
      };
    }),
  }));
}
