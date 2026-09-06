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
import { PIPELINE_STEPS, SPENDING_STEPS, type PipelineStep } from '@thp/shared';
import type { HandlerRegistry } from '../../src/handlers';
import { runJob } from '../../src/run-job';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * The daily spend ceiling, at the runner (docs/project/prd.md, 3.21.2.8).
 *
 * What is pinned: a paid step reached after the ceiling fails naming the ceiling and **never calls
 * its handler**; a free step runs regardless; a paid step under the ceiling runs; and the total
 * the ceiling is checked against is what succeeded work recorded, so a job that starts under it is
 * allowed to finish over it. The ledger's own arithmetic is `packages/db/tests/integration/spend.test.ts`.
 */

describe('the spend ceiling at the runner', () => {
  let target: ThrowawayDatabase;
  let sql: postgres.Sql;
  let handle: DatabaseHandle;
  let recordings = 0;
  let captured: LogLine[] = [];
  let restoreSink: () => void;

  async function claimedJob(step: PipelineStep): Promise<JobRow> {
    recordings += 1;
    const recording = await insertRecording(
      {
        originalMediaKey: `originals/ceiling-${recordings}.mp3`,
        title: `Teaching ${recordings}`,
        recordedAt: '2026-04-12',
      },
      handle,
    );
    const job = await enqueueJob(
      { recordingId: recording.id, step, correlationId: `ceiling-${recordings}` },
      handle,
    );
    await sql`update job set status = 'running', started_at = now() where id = ${job.id}`;
    return { ...job, status: 'running', startedAt: new Date() };
  }

  /** What an earlier paid job left in the ledger today. */
  async function alreadySpent(costUsd: number): Promise<void> {
    const job = await claimedJob('transcribe');
    await sql`
      update job set status = 'succeeded', finished_at = now(),
        provider_meta = ${sql.json({ provider: 'deepgram', costUsd })}
      where id = ${job.id}
    `;
  }

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'spend_ceiling');
    await runMigrations({ url: target.url });
    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    handle = createDatabase({ url: target.url, max: 4 });
    await alreadySpent(1.25);
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

  it('fails a paid step reached after the ceiling, naming it, and never calls the handler', async () => {
    const job = await claimedJob('transcribe');
    let ran = 0;
    const handlers: HandlerRegistry = {
      transcribe: () => {
        ran += 1;
      },
    };

    const row = await runJob(job, handlers, { executor: handle, spendCeilingUsd: 1 });

    expect(ran).toBe(0);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('spend ceiling reached: $1.25 of $1.00 today');
    expect(row.providerMeta).toBeNull();

    const failed = captured.find((line) => line.message === 'job.failed');
    expect(failed?.level).toBe('error');
    expect(failed).toMatchObject({ reason: 'spend-ceiling-reached', spentUsd: 1.25, ceilingUsd: 1 });
    // The operator-facing line, once.
    expect(captured.filter((line) => line.message === 'spend.ceiling.reached')).toHaveLength(1);
  });

  it('logs the operator-facing line once a day per process, not once per refused job', async () => {
    const job = await claimedJob('generate_draft');
    await runJob(job, { generate_draft: () => undefined }, { executor: handle, spendCeilingUsd: 1 });

    expect(captured.filter((line) => line.message === 'job.failed')).toHaveLength(1);
    expect(captured.filter((line) => line.message === 'spend.ceiling.reached')).toHaveLength(0);
  });

  it('enqueues nothing after a refused step — the chain stops as it does for any failure', async () => {
    const job = await claimedJob('transcribe');
    await runJob(job, { transcribe: () => undefined }, { executor: handle, spendCeilingUsd: 1 });

    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from job where recording_id = ${job.recordingId}
    `;
    expect(Number(row?.count)).toBe(1);
  });

  it('runs a free step whatever the ledger says', async () => {
    const job = await claimedJob('process_audio');
    let ran = 0;
    const row = await runJob(
      job,
      {
        process_audio: () => {
          ran += 1;
        },
      },
      { executor: handle, spendCeilingUsd: 0.01, steps: ['process_audio'] },
    );

    expect(ran).toBe(1);
    expect(row.status).toBe('succeeded');
  });

  it('runs a paid step under the ceiling, and lets it finish over it', async () => {
    const job = await claimedJob('transcribe');
    const row = await runJob(
      job,
      { transcribe: () => ({ provider: 'deepgram', costUsd: 5 }) },
      { executor: handle, spendCeilingUsd: 2, steps: ['transcribe'] },
    );

    expect(row.status).toBe('succeeded');
    expect(row.providerMeta).toEqual({ provider: 'deepgram', costUsd: 5 });

    // And now the next paid step is refused: the ledger reads what that job recorded.
    const next = await claimedJob('generate_chapters');
    const refused = await runJob(
      next,
      { generate_chapters: () => undefined },
      { executor: handle, spendCeilingUsd: 2 },
    );
    expect(refused.status).toBe('failed');
    expect(refused.error).toBe('spend ceiling reached: $6.25 of $2.00 today');
  });

  it('covers every step but the free one', () => {
    // Audio processing is ffmpeg on our own box; everything after it bills a provider.
    expect(SPENDING_STEPS).toEqual(PIPELINE_STEPS.filter((step) => step !== 'process_audio'));
  });
});
