import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  MAX_JOB_ERROR_LENGTH,
  createDatabase,
  enqueueJob,
  insertRecording,
  runMigrations,
  type DatabaseHandle,
  type JobRow,
} from '@thp/db';
import { setLogSink, type LogLine } from '@thp/shared/observability/logger';
import { PIPELINE_STEPS, type PipelineStep } from '@thp/shared';
import { STUB_HANDLERS, STUB_PROVIDER_META, type HandlerRegistry } from '../../src/handlers';
import { runJob } from '../../src/run-job';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * Running one claimed job, against a real database.
 *
 * The loop is driven with **fake handlers** rather than with real steps, which is the whole point
 * of the registry being a constructor argument: "a handler that throws fails the job and does not
 * take the worker with it" is a property of the runner, and asserting it through a real provider
 * would be asserting something else. The two stubs this ticket ships are exercised at the end, on
 * their own terms.
 */
describe('running a claimed job', () => {
  let target: ThrowawayDatabase;
  let sql: postgres.Sql;
  let handle: DatabaseHandle;
  let recordings = 0;
  let captured: LogLine[] = [];
  let restoreSink: () => void;

  /** A job in the state the worker finds one in: claimed, running, nothing recorded yet. */
  async function claimedJob(step: PipelineStep = 'transcribe'): Promise<JobRow> {
    recordings += 1;
    const recording = await insertRecording(
      {
        originalMediaKey: `originals/run-job-${recordings}.mp3`,
        title: `Teaching ${recordings}`,
        recordedAt: '2026-04-12',
      },
      handle,
    );
    const job = await enqueueJob(
      { recordingId: recording.id, step, correlationId: `run-job-${recordings}-correlation` },
      handle,
    );
    // Claimed by hand: `claimNextJob` is the next slice of this ticket, and what the runner does
    // with a row it was handed does not depend on how the row was handed to it.
    await sql`update job set status = 'running', started_at = now() where id = ${job.id}`;
    return { ...job, status: 'running', startedAt: new Date() };
  }

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'run_job');
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

  it('marks a job that returned succeeded, and leaves no error behind', async () => {
    const job = await claimedJob();
    let ran = 0;
    const handlers: HandlerRegistry = {
      transcribe: () => {
        ran += 1;
      },
    };

    const row = await runJob(job, handlers, { executor: handle });

    expect(ran).toBe(1);
    expect(row.status).toBe('succeeded');
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect(row.error).toBeNull();
    // Nothing returned, nothing recorded.
    expect(row.providerMeta).toBeNull();
  });

  it('records what the handler returned in provider_meta', async () => {
    const job = await claimedJob();
    const handlers: HandlerRegistry = {
      transcribe: () => ({ model: 'a-fake-model', spendCents: 3 }),
    };

    const row = await runJob(job, handlers, { executor: handle });

    expect(row.status).toBe('succeeded');
    expect(row.providerMeta).toEqual({ model: 'a-fake-model', spendCents: 3 });
  });

  it('marks a job whose handler threw failed, records why, and does not rethrow', async () => {
    const job = await claimedJob();
    const handlers: HandlerRegistry = {
      transcribe: () => {
        throw new Error('the provider refused the audio');
      },
    };

    // Not `rejects` — the runner returning normally *is* the assertion. A worker that rethrew here
    // would take the loop down with the job.
    const row = await runJob(job, handlers, { executor: handle });

    expect(row.status).toBe('failed');
    expect(row.error).toBe('the provider refused the audio');
    expect(row.finishedAt).toBeInstanceOf(Date);
  });

  it('truncates a failure too large to keep, and keeps the whole of it in the log', async () => {
    const job = await claimedJob();
    const enormous = 'x'.repeat(MAX_JOB_ERROR_LENGTH * 2);
    const handlers: HandlerRegistry = {
      transcribe: () => {
        throw new Error(enormous);
      },
    };

    const row = await runJob(job, handlers, { executor: handle });

    expect(row.error).toHaveLength(MAX_JOB_ERROR_LENGTH);
    expect(row.error?.startsWith('xxx')).toBe(true);
    const line = captured.find((entry) => entry.message === 'job.failed');
    expect(String(line?.['error'])).toContain(enormous);
  });

  it('fails a step nothing is registered for, naming the step', async () => {
    const job = await claimedJob('generate_draft');

    // A registry that knows the other step, so this is "not registered" rather than "empty".
    const row = await runJob(job, { transcribe: () => undefined }, { executor: handle });

    expect(row.status).toBe('failed');
    expect(row.error).toContain('generate_draft');
    expect(row.finishedAt).toBeInstanceOf(Date);
  });

  it('logs one line per outcome, carrying the job, the step, the recording and the id', async () => {
    const succeeding = await claimedJob();
    await runJob(succeeding, { transcribe: () => undefined }, { executor: handle });

    const failing = await claimedJob();
    await runJob(
      failing,
      {
        transcribe: () => {
          throw new Error('nope');
        },
      },
      { executor: handle },
    );

    const succeeded = captured.filter((line) => line.message === 'job.succeeded');
    const failed = captured.filter((line) => line.message === 'job.failed');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    expect(succeeded[0]).toMatchObject({
      jobId: succeeding.id,
      step: 'transcribe',
      recordingId: succeeding.recordingId,
      // Off the row, not out of an async frame — there is no request behind this process.
      correlationId: succeeding.correlationId,
    });
    expect(failed[0]).toMatchObject({
      jobId: failing.id,
      step: 'transcribe',
      recordingId: failing.recordingId,
      correlationId: failing.correlationId,
      reason: 'nope',
    });
  });
});

/**
 * The two stub handlers, on their own terms.
 *
 * They do no work, so what is worth asserting is the one thing that makes them honest: the marker
 * that tells a reader of the ledger this step *exists* rather than *ran*.
 */
describe('the stub handlers this ticket ships', () => {
  it('registers every step of the pipeline', () => {
    // Against the ordered list rather than against two names typed out here — the successor rule
    // reads that list too, and a step added to it with no handler is a job that fails.
    expect(Object.keys(STUB_HANDLERS).sort()).toEqual([...PIPELINE_STEPS].sort());
  });

  it('marks itself, so a succeeded row is not mistaken for work done', () => {
    for (const step of PIPELINE_STEPS) {
      const handler = STUB_HANDLERS[step];
      expect(handler).toBeDefined();
      expect(handler?.({} as JobRow)).toEqual(STUB_PROVIDER_META);
    }
    expect(STUB_PROVIDER_META).toEqual({ stub: true });
  });
});
