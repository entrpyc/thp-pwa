import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  createDatabase,
  enqueueJob,
  findUnfinishedJob,
  insertRecording,
  runMigrations,
  type DatabaseHandle,
} from '@thp/db';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * Enqueuing, against a freshly migrated database rather than against a stub.
 *
 * Everything asserted here is a property the *database* holds rather than one the caller keeps:
 * the number `attempt` gets, and what happens when the same step is enqueued while one is already
 * in flight. A fake queue would answer both however we wrote it, which is why there isn't one —
 * the partial unique index is the mechanism, and a test that does not touch Postgres cannot see it.
 */
describe('enqueuing a step', () => {
  let target: ThrowawayDatabase;
  let sql: postgres.Sql;
  let handle: DatabaseHandle;
  let recordings = 0;

  /** A recording of its own per test, so no test can be affected by another's rows. */
  async function newRecording(): Promise<string> {
    recordings += 1;
    const row = await insertRecording(
      {
        originalMediaKey: `originals/queue-${recordings}.mp3`,
        title: `Teaching ${recordings}`,
        recordedAt: '2026-02-15',
      },
      handle,
    );
    return row.id;
  }

  async function countJobs(recordingId: string): Promise<number> {
    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from job where recording_id = ${recordingId}
    `;
    return Number(row?.count ?? '0');
  }

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'jobs');
    await runMigrations({ url: target.url });
    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    handle = createDatabase({ url: target.url, max: 4 });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('writes a pending row carrying the step, the recording and the correlation id', async () => {
    const recordingId = await newRecording();

    const row = await enqueueJob(
      { recordingId, step: 'transcribe', correlationId: 'a-known-correlation-id' },
      handle,
    );

    expect(row.recordingId).toBe(recordingId);
    expect(row.step).toBe('transcribe');
    expect(row.correlationId).toBe('a-known-correlation-id');
    expect(row.status).toBe('pending');
    expect(row.attempt).toBe(1);
    expect(row.enqueuedAt).toBeInstanceOf(Date);
    // Nothing has run it, so the three columns a run fills are empty.
    expect(row.startedAt).toBeNull();
    expect(row.finishedAt).toBeNull();
    expect(row.error).toBeNull();
    expect(row.providerMeta).toBeNull();
  });

  it('counts attempts from 1, one higher for each run of the same step', async () => {
    const recordingId = await newRecording();

    const first = await enqueueJob(
      { recordingId, step: 'transcribe', correlationId: 'first-request' },
      handle,
    );
    expect(first.attempt).toBe(1);

    // The step failed. docs/project/prd.md 3.21.2.3 halts the pipeline and a human re-enqueues it —
    // which is a new row, because the ledger is append-only.
    await sql`update job set status = 'failed', finished_at = now() where id = ${first.id}`;

    const second = await enqueueJob(
      { recordingId, step: 'transcribe', correlationId: 'second-request' },
      handle,
    );
    expect(second.attempt).toBe(2);
    expect(second.id).not.toBe(first.id);
    // The failed row is still there and still says what happened.
    expect(await countJobs(recordingId)).toBe(2);
  });

  it('counts attempts per step, not per recording', async () => {
    const recordingId = await newRecording();

    const transcribe = await enqueueJob(
      { recordingId, step: 'transcribe', correlationId: 'a-request' },
      handle,
    );
    await sql`update job set status = 'succeeded', finished_at = now() where id = ${transcribe.id}`;
    const again = await enqueueJob(
      { recordingId, step: 'transcribe', correlationId: 'a-request' },
      handle,
    );
    const draft = await enqueueJob(
      { recordingId, step: 'generate_draft', correlationId: 'a-request' },
      handle,
    );

    expect(again.attempt).toBe(2);
    expect(draft.attempt).toBe(1);
  });

  it('is a no-op returning the existing job when one is already unfinished', async () => {
    const recordingId = await newRecording();

    const first = await enqueueJob(
      { recordingId, step: 'transcribe', correlationId: 'the-first-request' },
      handle,
    );
    const second = await enqueueJob(
      { recordingId, step: 'transcribe', correlationId: 'a-different-request' },
      handle,
    );

    // The same job, not an error and not a second row — which is what makes an admin
    // double-clicking Ticket 04's re-run harmless.
    expect(second.id).toBe(first.id);
    expect(second.attempt).toBe(1);
    // And the row still carries the request that actually created it.
    expect(second.correlationId).toBe('the-first-request');
    expect(await countJobs(recordingId)).toBe(1);
  });

  it('treats a claimed job as unfinished too', async () => {
    const recordingId = await newRecording();
    const first = await enqueueJob(
      { recordingId, step: 'transcribe', correlationId: 'the-first-request' },
      handle,
    );
    await sql`update job set status = 'running', started_at = now() where id = ${first.id}`;

    // Otherwise an enqueue during a run would hand a second worker the step already in progress.
    const second = await enqueueJob(
      { recordingId, step: 'transcribe', correlationId: 'a-later-request' },
      handle,
    );
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('running');
    expect(await countJobs(recordingId)).toBe(1);
  });

  it('reports whether a step is in flight, and stops reporting one once it finishes', async () => {
    const recordingId = await newRecording();
    expect(await findUnfinishedJob(recordingId, 'transcribe', handle)).toBeNull();

    const row = await enqueueJob(
      { recordingId, step: 'transcribe', correlationId: 'a-request' },
      handle,
    );
    expect((await findUnfinishedJob(recordingId, 'transcribe', handle))?.id).toBe(row.id);

    await sql`update job set status = 'succeeded', finished_at = now() where id = ${row.id}`;
    expect(await findUnfinishedJob(recordingId, 'transcribe', handle)).toBeNull();
  });
});
