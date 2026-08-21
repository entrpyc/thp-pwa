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
import { startWorkerLoop } from '../../src/loop';
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

  /** A job waiting to be claimed, on a recording of its own. */
  async function queuedJob(step: PipelineStep = 'transcribe'): Promise<JobRow> {
    const recordingId = await newRecording();
    return enqueueJob(
      { recordingId, step, correlationId: `sweep-${recordings}-correlation` },
      handle,
    );
  }

  /** A job in the state a killed worker leaves behind: claimed, running, never finished. */
  async function abandonedJob(step: PipelineStep = 'transcribe'): Promise<JobRow> {
    const job = await queuedJob(step);
    await sql`update job set status = 'running', started_at = now() where id = ${job.id}`;
    return { ...job, status: 'running', startedAt: new Date() };
  }

  async function statusOf(jobId: string): Promise<string | undefined> {
    const [row] = await sql<{ status: string }[]>`
      select status::text as status from job where id = ${jobId}
    `;
    return row?.status;
  }

  /** Wait for something a loop does in the background, or fail saying what never happened. */
  async function waitFor(what: string, predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
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

  beforeEach(async () => {
    // An empty ledger per test: the sweep and the loop both read *every* row, so a job another
    // test left waiting is a job this one would claim.
    await sql`delete from job`;
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
    const job = await queuedJob('transcribe');
    const ranFor: string[] = [];

    // A handler that never returns: the first worker is *inside* it when the process dies.
    const interrupted = startWorkerLoop({
      executor: handle,
      pollIntervalMs: 20,
      handlers: {
        transcribe: (running: JobRow) => {
          ranFor.push(running.id);
          return new Promise<void>(() => {});
        },
      },
    });

    await waitFor('the first worker to start the handler', async () => ranFor.length === 1);

    // **The kill.** `stop()` without awaiting `done`: the job in flight never finishes and nothing
    // releases that handler — a process that had been killed would not release it either. So the
    // row is left `running`, which is exactly the state the sweep exists for.
    interrupted.stop();
    expect(await statusOf(job.id)).toBe('running');

    const [reclaimed] = await sweepAbandonedJobs(handle);
    const requeued = reclaimed?.requeued as JobRow;
    expect(requeued.attempt).toBe(2);

    // The next boot, with a handler that returns.
    const restarted = startWorkerLoop({
      executor: handle,
      pollIntervalMs: 20,
      handlers: {
        transcribe: (running: JobRow) => {
          ranFor.push(running.id);
        },
      },
    });
    try {
      await waitFor('the reclaimed job to finish', async () => {
        return (await statusOf(requeued.id)) === 'succeeded';
      });
    } finally {
      restarted.stop();
      await restarted.done;
    }

    // **At-least-once, stated as a test rather than as prose.** Two runs of the same step over the
    // same recording, and neither of them performed by this test — the first is the interrupted
    // worker's, the second is the restarted worker's. Which is why every handler in this epic and
    // every later epic must be idempotent.
    expect(ranFor).toEqual([job.id, requeued.id]);
    expect(requeued.recordingId).toBe(job.recordingId);
    expect(requeued.step).toBe(job.step);

    const rows = await ledger(job.recordingId);
    const attempts = rows.filter((row) => row.step === 'transcribe');
    expect(attempts.map((row) => row.status)).toEqual(['failed', 'succeeded']);
    expect(attempts[0]?.error).toContain('restarted');

    // And the re-run is a full run: it succeeded, so it chained forward exactly as a first run
    // would have. Nothing about a reclaimed job is second class. What then happens to that
    // successor is this loop's registry's business — it was given `transcribe` and nothing else —
    // so only its existence is asserted here.
    expect(rows.some((row) => row.step === 'generate_draft')).toBe(true);
  }, 60_000);
});
