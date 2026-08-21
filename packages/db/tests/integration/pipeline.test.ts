import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  completeJob,
  createDatabase,
  enqueueJob,
  failJob,
  insertRecording,
  readPipeline,
  runMigrations,
  type DatabaseHandle,
  type RecordingPipelineRow,
} from '@thp/db';
import { PIPELINE_STEPS, type PipelineStep } from '@thp/shared';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * The pipeline read, against a real ledger.
 *
 * Three properties carry the suite, and each of them is a property the append-only ledger makes
 * non-obvious:
 *
 * 1. **The answer is the latest attempt of each step**, not an aggregate over its history. A step
 *    that failed and was re-run has two rows, and the screen shows the second one.
 * 2. **A step that was never enqueued reads as not started**, rather than being absent — so the
 *    answer has one entry per step of the chain however long the chain becomes.
 * 3. **A recording with no jobs at all is still returned.** A left join, because a recording
 *    nothing will ever process is exactly the failure this screen exists to make visible.
 */
describe('reading what the pipeline is doing', () => {
  let target: ThrowawayDatabase;
  let sql: postgres.Sql;
  let handle: DatabaseHandle;
  let recordings = 0;

  /** A recording, dated so the newest-first order is drivable. `recordedAt` descends as we go. */
  async function newRecording(recordedAt = '2026-04-12', title?: string): Promise<string> {
    recordings += 1;
    const row = await insertRecording(
      {
        originalMediaKey: `originals/pipeline-${recordings}.mp3`,
        title: title ?? `Teaching ${recordings}`,
        recordedAt,
      },
      handle,
    );
    return row.id;
  }

  /** The pipeline of one recording, by id — the suite shares a database with nothing, but rows add up. */
  async function pipelineOf(recordingId: string): Promise<RecordingPipelineRow> {
    const found = (await readPipeline(handle)).find((one) => one.recordingId === recordingId);
    if (!found) throw new Error(`no pipeline row came back for recording ${recordingId}`);
    return found;
  }

  function stepOf(row: RecordingPipelineRow, step: PipelineStep) {
    const found = row.steps.find((one) => one.step === step);
    if (!found) throw new Error(`no ${step} in the answer`);
    return found;
  }

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'pipeline');
    await runMigrations({ url: target.url });
    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    handle = createDatabase({ url: target.url, max: 4 });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('returns a recording with no jobs at all, with every step not started', async () => {
    // Written directly, with nothing enqueued behind it — which is what a finalisation whose
    // enqueue never happened would leave, and the one state this screen most has to be able to show.
    const recordingId = await newRecording();

    const row = await pipelineOf(recordingId);
    expect(row.steps.map((one) => one.step)).toEqual([...PIPELINE_STEPS]);
    expect(row.steps.every((one) => one.status === null)).toBe(true);
    expect(row.steps.every((one) => one.attempt === null)).toBe(true);
    expect(row.steps.every((one) => one.enqueuedAt === null)).toBe(true);
  });

  it('reports a freshly finalised recording as transcribe waiting and generate_draft not started', async () => {
    const recordingId = await newRecording();
    await enqueueJob({ recordingId, step: 'transcribe', correlationId: 'fresh' }, handle);

    const row = await pipelineOf(recordingId);
    expect(stepOf(row, 'transcribe').status).toBe('pending');
    expect(stepOf(row, 'transcribe').attempt).toBe(1);
    // Not absent, and not "nothing": the chain has not reached it yet, and the screen says so.
    expect(stepOf(row, 'generate_draft').status).toBeNull();
  });

  it('has one entry per step of the chain, read from the step list rather than named', async () => {
    const recordingId = await newRecording();

    const row = await pipelineOf(recordingId);
    // §3.4's `process_audio` arriving is a step this read grows on its own, because the list is
    // where the steps come from and this file does not restate it.
    expect(row.steps).toHaveLength(PIPELINE_STEPS.length);
    expect(row.steps.map((one) => one.step)).toEqual([...PIPELINE_STEPS]);
  });

  it('returns each step’s status, attempt, reason and the three timestamps', async () => {
    const recordingId = await newRecording();
    const queued = await enqueueJob(
      { recordingId, step: 'transcribe', correlationId: 'a-request' },
      handle,
    );
    await sql`update job set status = 'running', started_at = now() where id = ${queued.id}`;
    await failJob(queued.id, 'Deepgram refused the audio with HTTP 415', handle);

    const step = stepOf(await pipelineOf(recordingId), 'transcribe');
    expect(step.status).toBe('failed');
    expect(step.attempt).toBe(1);
    // The reason, in the row — which is what stops a failure being something an operator has to
    // go and read a log to discover.
    expect(step.error).toBe('Deepgram refused the audio with HTTP 415');
    expect(step.enqueuedAt).toBeInstanceOf(Date);
    expect(step.startedAt).toBeInstanceOf(Date);
    expect(step.finishedAt).toBeInstanceOf(Date);
  });

  it('reports the latest attempt of a step, not its history', async () => {
    const recordingId = await newRecording();
    const first = await enqueueJob(
      { recordingId, step: 'transcribe', correlationId: 'first-try' },
      handle,
    );
    await failJob(first.id, 'the provider refused the audio', handle);

    const second = await enqueueJob(
      { recordingId, step: 'transcribe', correlationId: 'second-try' },
      handle,
    );

    const step = stepOf(await pipelineOf(recordingId), 'transcribe');
    // The ledger is append-only, so both rows are still there — and "the status of transcribe for
    // this recording" is the row with the highest attempt, which is the one that is waiting.
    expect(step.attempt).toBe(2);
    expect(step.status).toBe('pending');
    expect(step.error).toBeNull();
    expect(second.attempt).toBe(2);

    const [rows] = await sql<{ count: string }[]>`
      select count(*)::text as count from job
      where recording_id = ${recordingId} and step = 'transcribe'
    `;
    expect(rows?.count).toBe('2');
  });

  it('carries what the handler recorded, so a stub is tellable from a real success', async () => {
    const recordingId = await newRecording();
    const queued = await enqueueJob(
      { recordingId, step: 'generate_draft', correlationId: 'stubbed' },
      handle,
    );
    await completeJob(queued.id, { stub: true }, handle);

    const step = stepOf(await pipelineOf(recordingId), 'generate_draft');
    expect(step.status).toBe('succeeded');
    expect(step.providerMeta).toEqual({ stub: true });
  });

  it('reads every recording in one query, with each step at its own status', async () => {
    // Four recordings, four different states, one call. That is what "one query over the ledger,
    // not log-reading" has to mean to be worth saying.
    const waiting = await newRecording();
    await enqueueJob({ recordingId: waiting, step: 'transcribe', correlationId: 'a' }, handle);

    const running = await newRecording();
    const claimed = await enqueueJob(
      { recordingId: running, step: 'transcribe', correlationId: 'b' },
      handle,
    );
    await sql`update job set status = 'running', started_at = now() where id = ${claimed.id}`;

    const done = await newRecording();
    const doneJob = await enqueueJob(
      { recordingId: done, step: 'transcribe', correlationId: 'c' },
      handle,
    );
    await completeJob(doneJob.id, { model: 'general-nova-3' }, handle);

    const broken = await newRecording();
    const brokenJob = await enqueueJob(
      { recordingId: broken, step: 'transcribe', correlationId: 'd' },
      handle,
    );
    await failJob(brokenJob.id, 'no object at key', handle);

    const all = await readPipeline(handle);
    const statusOf = (id: string) =>
      all.find((one) => one.recordingId === id)?.steps.find((one) => one.step === 'transcribe')
        ?.status ?? null;

    expect(statusOf(waiting)).toBe('pending');
    expect(statusOf(running)).toBe('running');
    expect(statusOf(done)).toBe('succeeded');
    expect(statusOf(broken)).toBe('failed');
  });

  it('comes back newest recorded first, matching the recordings list', async () => {
    const older = await newRecording('2024-01-05', 'An older teaching');
    const newer = await newRecording('2024-01-06', 'A newer teaching');

    const all = await readPipeline(handle);
    const positions = [older, newer].map((id) =>
      all.findIndex((one) => one.recordingId === id),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    // The order is the query's, so the client has no second answer to "what is most recent".
    expect(positions[1]!).toBeLessThan(positions[0]!);
  });

  it('carries the title and the date the row holds', async () => {
    const recordingId = await newRecording('2026-06-21', 'The teaching on the second chapter');

    const row = await pipelineOf(recordingId);
    expect(row.title).toBe('The teaching on the second chapter');
    // A SQL `date`, so it comes back as the string it was written as rather than as a moment.
    expect(row.recordedAt).toBe('2026-06-21');
  });
});
