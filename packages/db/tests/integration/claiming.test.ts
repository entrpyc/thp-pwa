import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import {
  claimNextJob,
  createDatabase,
  enqueueJob,
  insertRecording,
  runMigrations,
  type DatabaseHandle,
} from '@thp/db';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * Claiming, against a real Postgres.
 *
 * Every property here is a property of `for update skip locked` and of nothing else — that a locked
 * row is passed over rather than waited for, and that two claims at the same instant cannot come
 * back with the same job. A fake queue would answer both however we wrote it, so the tests below
 * open real transactions and hold real locks.
 */
describe('claiming the next job', () => {
  let target: ThrowawayDatabase;
  let sql2: postgres.Sql;
  let handle: DatabaseHandle;
  let recordings = 0;

  async function newRecording(): Promise<string> {
    recordings += 1;
    const row = await insertRecording(
      {
        originalMediaKey: `originals/claim-${recordings}.mp3`,
        title: `Teaching ${recordings}`,
        recordedAt: '2026-07-19',
      },
      handle,
    );
    return row.id;
  }

  /** A pending job of its own recording, so the pair's uniqueness rule never gets in the way. */
  async function waitingJob(): Promise<string> {
    const recordingId = await newRecording();
    const job = await enqueueJob(
      { recordingId, step: 'transcribe', correlationId: `claim-${recordings}-correlation` },
      handle,
    );
    return job.id;
  }

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'claiming');
    await runMigrations({ url: target.url });
    sql2 = postgres(target.url, { max: 4, onnotice: () => {} });
    // Room for a held lock and several concurrent claims at once — the point of the suite.
    handle = createDatabase({ url: target.url, max: 10 });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    await sql2?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  beforeEach(async () => {
    await sql2`delete from job`;
  });

  it('takes nothing from an empty queue, and that is not an error', async () => {
    await expect(claimNextJob(handle)).resolves.toBeNull();
  });

  it('marks what it took running and stamps when it started', async () => {
    const id = await waitingJob();

    const claimed = await claimNextJob(handle);

    expect(claimed?.id).toBe(id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.startedAt).toBeInstanceOf(Date);
    // And the change is on the row, not only in what came back.
    const [row] = await sql2<{ status: string }[]>`
      select status::text as status from job where id = ${id}
    `;
    expect(row?.status).toBe('running');
  });

  it('takes the oldest first', async () => {
    const first = await waitingJob();
    const second = await waitingJob();
    const third = await waitingJob();

    // Written in the same millisecond or not, the order is `enqueued_at` then `id` — never the
    // planner's choice of the second.
    await sql2`update job set enqueued_at = now() - interval '3 minutes' where id = ${first}`;
    await sql2`update job set enqueued_at = now() - interval '2 minutes' where id = ${second}`;
    await sql2`update job set enqueued_at = now() - interval '1 minute' where id = ${third}`;

    const order: (string | undefined)[] = [];
    for (let taken = 0; taken < 3; taken += 1) {
      order.push((await claimNextJob(handle))?.id);
    }

    expect(order).toEqual([first, second, third]);
  });

  it('skips a row another transaction is holding rather than waiting for it', async () => {
    const id = await waitingJob();

    await handle.db.transaction(async (tx) => {
      // The only pending row, locked and held for the duration of this block.
      await tx.execute(sql`select id from job where id = ${id} for update`);

      // A worker that waited here would block until the lock went away — and with one job in the
      // queue that means a worker that appears to have hung. It passes over instead.
      await expect(claimNextJob(handle)).resolves.toBeNull();
    });

    // Once the lock is gone the job is claimable again: it was skipped, not consumed.
    expect((await claimNextJob(handle))?.id).toBe(id);
  });

  it('never hands the same job to two claims at once', async () => {
    const queued = [];
    for (let count = 0; count < 5; count += 1) queued.push(await waitingJob());

    // More claims than jobs, all in flight together: the two extra must come back empty rather
    // than duplicate somebody else's work.
    const claims = await Promise.all(
      Array.from({ length: 7 }, () => claimNextJob(handle)),
    );

    const taken = claims.filter((claimed) => claimed !== null).map((claimed) => claimed.id);
    expect(new Set(taken).size).toBe(taken.length);
    expect([...taken].sort()).toEqual([...queued].sort());
    expect(claims.filter((claimed) => claimed === null)).toHaveLength(2);
  });
});
