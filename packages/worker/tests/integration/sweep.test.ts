import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  createDatabase,
  enqueueJob,
  insertRecording,
  runMigrations,
  type DatabaseHandle,
  type JobRow,
} from '@thp/db';
import { setLogSink, type LogLine } from '@thp/shared/observability/logger';
import type { PipelineStep } from '@thp/shared';
import { SOLE_WORKER_ASSUMPTION, sweepAbandonedJobs } from '../../src/sweep';
import { runJob } from '../../src/run-job';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * The startup sweep, against a real database.
 *
 * What is under test is a claim about the *state of the world at boot*: a job that says `running`
 * has nobody running it, because the process that claimed it is the one that just started. So the
 * sweep is asserted the only way that claim can be — by leaving rows in that state and starting
 * over.
 */
describe('the startup sweep', () => {
  let target: ThrowawayDatabase;
  let sql: postgres.Sql;
  let handle: DatabaseHandle;
  let recordings = 0;
  let captured: LogLine[] = [];
  let restoreSink: () => void;

  interface LedgerRow {
    readonly id: string;
    readonly step: PipelineStep;
    readonly status: string;
    readonly attempt: number;
    readonly error: string | null;
    readonly correlation_id: string;
  }

  async function newRecording(): Promise<string> {
    recordings += 1;
    const row = await insertRecording(
      {
        originalMediaKey: `originals/sweep-${recordings}.mp3`,
        title: `Teaching ${recordings}`,
        recordedAt: '2026-06-07',
      },
      handle,
    );
    return row.id;
  }

  /** A job in the state a killed worker leaves behind: claimed, running, never finished. */
  async function abandonedJob(step: PipelineStep = 'transcribe'): Promise<JobRow> {
    const recordingId = await newRecording();
    const job = await enqueueJob(
      { recordingId, step, correlationId: `sweep-${recordings}-correlation` },
      handle,
    );
    await sql`update job set status = 'running', started_at = now() where id = ${job.id}`;
    return { ...job, status: 'running', startedAt: new Date() };
  }

  async function ledger(recordingId: string): Promise<LedgerRow[]> {
    return (await sql<LedgerRow[]>`
      select id, step::text as step, status::text as status, attempt, error, correlation_id
      from job where recording_id = ${recordingId} order by enqueued_at, id
    `) as unknown as LedgerRow[];
  }

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'sweep');
    await runMigrations({ url: target.url });
    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    handle = createDatabase({ url: target.url, max: 4 });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  beforeEach(() => {
    captured = [];
    restoreSink = setLogSink((line) => captured.push(line));
    return () => restoreSink();
  });

  it('fails the abandoned row and queues a fresh attempt of the same step', async () => {
    const job = await abandonedJob('transcribe');

    const reclaimed = await sweepAbandonedJobs(handle);

    expect(reclaimed).toHaveLength(1);
    const rows = await ledger(job.recordingId);
    expect(rows).toHaveLength(2);

    // The old row says what happened to it rather than sitting `running` forever.
    expect(rows[0]?.id).toBe(job.id);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toContain('restarted');

    // And the recording carries on: the same step, the next attempt, the same correlation id.
    expect(rows[1]?.status).toBe('pending');
    expect(rows[1]?.step).toBe('transcribe');
    expect(rows[1]?.attempt).toBe(job.attempt + 1);
    expect(rows[1]?.correlation_id).toBe(job.correlationId);
  });

  it('leaves everything that was not running exactly as it was', async () => {
    const recordingId = await newRecording();
    const waiting = await enqueueJob(
      { recordingId, step: 'transcribe', correlationId: 'a-request' },
      handle,
    );
    const done = await enqueueJob(
      { recordingId, step: 'generate_draft', correlationId: 'a-request' },
      handle,
    );
    await sql`update job set status = 'succeeded', finished_at = now() where id = ${done.id}`;

    await sweepAbandonedJobs(handle);

    // A pending job is work nobody has started, not work somebody abandoned; a finished job is
    // finished. Re-queuing either would be a retry, and there is no retry in this epic.
    const rows = await ledger(recordingId);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === waiting.id)?.status).toBe('pending');
    expect(rows.find((row) => row.id === done.id)?.status).toBe('succeeded');
  });

  it('is not an error when there was nothing in flight', async () => {
    await expect(sweepAbandonedJobs(handle)).resolves.toEqual([]);
  });

  it('logs one line per reclaimed job, and one naming what it assumes', async () => {
    const first = await abandonedJob('transcribe');
    const second = await abandonedJob('generate_draft');

    await sweepAbandonedJobs(handle);

    const assumption = captured.filter((line) => line.message === 'worker.sweep.start');
    expect(assumption).toHaveLength(1);
    // The line a person finds the day somebody runs two workers and cannot explain the duplicated
    // work. It has to say the assumption, not merely that a sweep happened.
    expect(String(assumption[0]?.['assumption'])).toBe(SOLE_WORKER_ASSUMPTION);
    expect(String(assumption[0]?.['assumption'])).toContain('only worker');

    const reclaimed = captured.filter((line) => line.message === 'worker.sweep.reclaimed');
    expect(reclaimed).toHaveLength(2);
    expect(reclaimed.map((line) => line['jobId'])).toEqual([first.id, second.id]);
    expect(reclaimed[0]).toMatchObject({
      step: 'transcribe',
      recordingId: first.recordingId,
      // Traceable to the upload that caused it — the sweep has no request of its own.
      correlationId: first.correlationId,
    });
  });

  it('runs the handler of an interrupted job a second time', async () => {
    const job = await abandonedJob('transcribe');
    const ranFor: string[] = [];
    const handlers = {
      transcribe: (running: JobRow) => {
        ranFor.push(running.id);
      },
    };

    // The kill: the handler had started and the process went away, so the row is still `running`
    // and the work was never recorded. That is the state `abandonedJob` above leaves behind.
    ranFor.push(job.id);

    const [reclaimed] = await sweepAbandonedJobs(handle);
    expect(reclaimed).toBeDefined();
    const requeued = reclaimed?.requeued as JobRow;

    // The next boot picks the fresh attempt up and runs the same step over the same recording.
    // (The loop that would claim it is the last slice of this ticket; the row it would hand over is
    // this one.)
    await sql`update job set status = 'running', started_at = now() where id = ${requeued.id}`;
    await runJob(requeued, handlers, { executor: handle });

    // **At-least-once, stated as a test rather than as prose.** Which is why every handler in this
    // epic and every later epic must be idempotent.
    expect(ranFor).toHaveLength(2);
    expect(new Set(ranFor).size).toBe(2);
    // And the re-run is a full run: it succeeded, so it chained forward exactly as a first run
    // would have. Nothing about a reclaimed job is second class.
    const rows = await ledger(job.recordingId);
    expect(rows.map((row) => [row.step, row.status])).toEqual([
      ['transcribe', 'failed'],
      ['transcribe', 'succeeded'],
      ['generate_draft', 'pending'],
    ]);
  });
});
