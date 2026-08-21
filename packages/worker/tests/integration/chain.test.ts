import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  createDatabase,
  enqueueJob,
  insertRecording,
  runMigrations,
  type DatabaseHandle,
  type JobRow,
} from '@thp/db';
import { PIPELINE_STEPS, type PipelineStep } from '@thp/shared';
import { setLogSink } from '@thp/shared/observability/logger';
import { runJob } from '../../src/run-job';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * The chain rule: a step that succeeds enqueues its successor, in the transaction that marks it
 * succeeded, and a step that fails enqueues nothing.
 *
 * Driven with fake handlers, because what is under test is the *rule* — which step follows which,
 * and what is left behind when the write fails half way. The successor is read from an ordered list
 * the runner is given, so the last test here drives the chain from a **reordered** one: that is the
 * difference between "the successor comes from the list" and "the successor happens to be right".
 */
describe('a step that succeeds enqueues the next one', () => {
  let target: ThrowawayDatabase;
  let sql: postgres.Sql;
  let handle: DatabaseHandle;
  let recordings = 0;
  let restoreSink: () => void;

  interface LedgerRow {
    readonly id: string;
    readonly step: PipelineStep;
    readonly status: string;
    readonly attempt: number;
    readonly correlation_id: string;
  }

  async function claimedJob(step: PipelineStep = 'transcribe'): Promise<JobRow> {
    recordings += 1;
    const recording = await insertRecording(
      {
        originalMediaKey: `originals/chain-${recordings}.mp3`,
        title: `Teaching ${recordings}`,
        recordedAt: '2026-05-03',
      },
      handle,
    );
    const job = await enqueueJob(
      { recordingId: recording.id, step, correlationId: `chain-${recordings}-correlation` },
      handle,
    );
    await sql`update job set status = 'running', started_at = now() where id = ${job.id}`;
    return { ...job, status: 'running', startedAt: new Date() };
  }

  async function ledger(recordingId: string): Promise<LedgerRow[]> {
    return (await sql<LedgerRow[]>`
      select id, step::text as step, status::text as status, attempt, correlation_id
      from job where recording_id = ${recordingId} order by enqueued_at, id
    `) as unknown as LedgerRow[];
  }

  const succeeds = { transcribe: () => undefined, generate_draft: () => undefined };

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'chain');
    await runMigrations({ url: target.url });
    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    handle = createDatabase({ url: target.url, max: 4 });
    restoreSink = setLogSink(() => {});
  }, 120_000);

  afterAll(async () => {
    restoreSink?.();
    await handle?.close();
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('leaves the successor pending, carrying the same correlation id', async () => {
    const job = await claimedJob('transcribe');

    await runJob(job, succeeds, { executor: handle });

    const rows = await ledger(job.recordingId);
    expect(rows.map((row) => [row.step, row.status])).toEqual([
      ['transcribe', 'succeeded'],
      ['generate_draft', 'pending'],
    ]);
    // The first run of the successor, under the id of the request that started the whole chain.
    expect(rows[1]?.attempt).toBe(1);
    expect(rows[1]?.correlation_id).toBe(job.correlationId);
  });

  it('lands both changes or neither', async () => {
    const job = await claimedJob('transcribe');

    // A successor the database has never heard of: the insert fails on the `pipeline_step` enum,
    // inside the transaction that had just marked this step succeeded.
    const impossible: PipelineStep[] = ['transcribe', 'a_step_that_does_not_exist' as PipelineStep];
    await expect(runJob(job, succeeds, { executor: handle, steps: impossible })).rejects.toThrow();

    const rows = await ledger(job.recordingId);
    // Neither change landed: no successor row, and the step is still running rather than succeeded.
    // Which is the right state to be left in — the startup sweep reclaims it and runs it again.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('running');
  });

  it('enqueues nothing when the step failed', async () => {
    const job = await claimedJob('transcribe');

    await runJob(
      job,
      {
        transcribe: () => {
          throw new Error('the provider refused the audio');
        },
      },
      { executor: handle },
    );

    // docs/project/prd.md 3.21.2.3: the pipeline halts and flags. A failure genuinely stops the
    // recording rather than passing a half-done job to the next step.
    const rows = await ledger(job.recordingId);
    expect(rows.map((row) => [row.step, row.status])).toEqual([['transcribe', 'failed']]);
  });

  it('stops at the last step without treating that as a failure', async () => {
    const job = await claimedJob('generate_draft');

    const row = await runJob(job, succeeds, { executor: handle });

    expect(row.status).toBe('succeeded');
    expect(await ledger(job.recordingId)).toHaveLength(1);
  });

  it('enqueues nothing when the successor is already in flight', async () => {
    const job = await claimedJob('transcribe');
    const alreadyQueued = await enqueueJob(
      {
        recordingId: job.recordingId,
        step: 'generate_draft',
        correlationId: 'an-earlier-request',
      },
      handle,
    );

    // Not an error, and not a second row — the enqueue is a no-op returning the job already there.
    const row = await runJob(job, succeeds, { executor: handle });
    expect(row.status).toBe('succeeded');

    const rows = await ledger(job.recordingId);
    expect(rows).toHaveLength(2);
    const successor = rows.find((entry) => entry.step === 'generate_draft');
    expect(successor?.id).toBe(alreadyQueued.id);
    expect(successor?.correlation_id).toBe('an-earlier-request');
  });

  it('follows the order it was given, not a rule written into the handlers', async () => {
    const reversed = [...PIPELINE_STEPS].reverse();
    const job = await claimedJob('generate_draft');

    await runJob(job, succeeds, { executor: handle, steps: reversed });

    // In this order `transcribe` follows `generate_draft`, and it does — which is what makes
    // inserting a step an edit to one array (docs/project/prd.md §3.4's `process_audio`).
    const rows = await ledger(job.recordingId);
    expect(rows.map((row) => [row.step, row.status])).toEqual([
      ['generate_draft', 'succeeded'],
      ['transcribe', 'pending'],
    ]);
  });
});
