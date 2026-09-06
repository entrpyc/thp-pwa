import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres, { type JSONValue } from 'postgres';
import {
  createDatabase,
  enqueueJob,
  insertRecording,
  insertUser,
  raiseSpendCeilingToday,
  readSpendLedger,
  runMigrations,
  spendCeilingReached,
  type DatabaseHandle,
} from '@thp/db';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * The daily spend ledger (docs/project/prd.md, 3.21.2.8).
 *
 * Rows are written by hand with the shapes the worker actually leaves behind — a succeeded job
 * with a cost, a failed one, one from yesterday, one whose meta says nothing about cost — and the
 * ledger is asked what today cost. What is pinned: which rows count, that the day is a UTC day
 * decided by the database, and that a raise is one row per day that only ever goes up.
 */

describe('the spend ledger', () => {
  let target: ThrowawayDatabase;
  let sql: postgres.Sql;
  let handle: DatabaseHandle;
  let recordings = 0;
  let adminId: string;

  async function newRecording(): Promise<string> {
    recordings += 1;
    const row = await insertRecording(
      {
        originalMediaKey: `originals/spend-${recordings}.mp3`,
        title: `Teaching ${recordings}`,
        recordedAt: '2026-05-03',
      },
      handle,
    );
    return row.id;
  }

  /** A finished job, as the worker leaves one: status, finished_at and provider_meta. */
  async function finishedJob(input: {
    readonly step?: 'transcribe' | 'generate_draft' | 'generate_chapters' | 'process_audio';
    readonly status?: 'succeeded' | 'failed';
    /** How long before now it finished, as a Postgres interval. Defaults to just now. */
    readonly finishedAgo?: string;
    readonly providerMeta?: JSONValue | null;
  }): Promise<void> {
    const recordingId = await newRecording();
    const job = await enqueueJob(
      { recordingId, step: input.step ?? 'transcribe', correlationId: `spend-${recordings}` },
      handle,
    );
    const ago = input.finishedAgo ?? '0 seconds';
    // `sql.json`, not a stringified parameter cast to jsonb: postgres.js serialises a string bound
    // to a jsonb position as a JSON *string*, which would store `"{...}"` and count as nothing.
    const meta = input.providerMeta === null ? null : sql.json(input.providerMeta ?? {});
    await sql`
      update job
      set status = ${input.status ?? 'succeeded'},
          started_at = now(),
          finished_at = now() - ${ago}::interval,
          provider_meta = ${meta}
      where id = ${job.id}
    `;
  }

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'spend');
    await runMigrations({ url: target.url });
    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    handle = createDatabase({ url: target.url, max: 4 });
    const admin = await insertUser(
      {
        email: 'spend-admin@example.test',
        passwordHash: 'not-a-real-hash',
        displayName: 'Spend Admin',
        role: 'admin',
      },
      handle,
    );
    adminId = admin.id;
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('starts empty, at the configured default, with the day ending in the future', async () => {
    const ledger = await readSpendLedger(2, handle);

    expect(ledger.todayUsd).toBe(0);
    expect(ledger.ceilingUsd).toBe(2);
    expect(ledger.defaultUsd).toBe(2);
    expect(ledger.raise).toBeNull();
    expect(spendCeilingReached(ledger)).toBe(false);
    expect(ledger.dayEndsAt.getTime()).toBeGreaterThan(Date.now());
    expect(ledger.dayEndsAt.getTime() - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    // The day ends at UTC midnight, whatever the session's clock says.
    expect(ledger.dayEndsAt.toISOString()).toMatch(/T00:00:00\.000Z$/);
  });

  it('sums what succeeded paid work cost today, and nothing else', async () => {
    await finishedJob({ step: 'transcribe', providerMeta: { costUsd: 0.39, provider: 'deepgram' } });
    await finishedJob({ step: 'generate_draft', providerMeta: { costUsd: 0.05, provider: 'minimax' } });
    await finishedJob({ step: 'generate_chapters', providerMeta: { costUsd: 0.04 } });
    // None of these count: a failure billed nothing we can read; yesterday is not today; a run
    // that recorded no cost is a run with no cost; a cost that is not a number is not a cost.
    await finishedJob({ status: 'failed', providerMeta: { costUsd: 99 } });
    await finishedJob({ finishedAgo: '1 day 1 minute', providerMeta: { costUsd: 99 } });
    await finishedJob({ providerMeta: null });
    await finishedJob({ providerMeta: { model: 'nova-3' } });
    await finishedJob({ providerMeta: { costUsd: 'lots' } });
    await finishedJob({ step: 'process_audio', providerMeta: { durationMs: 1200 } });

    const ledger = await readSpendLedger(2, handle);

    expect(ledger.todayUsd).toBe(0.48);
    expect(ledger.byStep).toEqual({
      process_audio: 0,
      transcribe: 0.39,
      generate_draft: 0.05,
      generate_chapters: 0.04,
    });
    expect(spendCeilingReached(ledger)).toBe(false);
  });

  it('is reached at the ceiling, not past it', async () => {
    const ledger = await readSpendLedger(0.48, handle);
    expect(spendCeilingReached(ledger)).toBe(true);
    expect(spendCeilingReached(await readSpendLedger(0.49, handle))).toBe(false);
  });

  it('takes the higher of the default and today’s raise, and remembers who raised it', async () => {
    const raised = await raiseSpendCeilingToday(
      { ceilingUsd: 5, raisedBy: adminId, reason: 'Backfilling March' },
      handle,
    );
    expect(raised.ceilingUsd).toBe(5);
    expect(raised.raisedBy).toBe(adminId);
    expect(raised.reason).toBe('Backfilling March');

    const ledger = await readSpendLedger(2, handle);
    expect(ledger.ceilingUsd).toBe(5);
    expect(ledger.defaultUsd).toBe(2);
    expect(ledger.raise?.ceilingUsd).toBe(5);
    expect(ledger.raise?.raisedBy).toBe(adminId);

    // A default above the raise wins: the raise is a floor-lift, never a cap.
    expect((await readSpendLedger(8, handle)).ceilingUsd).toBe(8);
  });

  it('only ever raises: a second, lower raise keeps the higher number and takes the new reason', async () => {
    const lower = await raiseSpendCeilingToday(
      { ceilingUsd: 3, raisedBy: adminId, reason: 'a smaller number' },
      handle,
    );
    expect(lower.ceilingUsd).toBe(5);
    expect(lower.reason).toBe('a smaller number');

    const higher = await raiseSpendCeilingToday({ ceilingUsd: 7.5, raisedBy: adminId, reason: null }, handle);
    expect(higher.ceilingUsd).toBe(7.5);

    const [row] = await sql<{ count: string }[]>`select count(*)::text as count from spend_ceiling_raise`;
    expect(Number(row?.count)).toBe(1);
  });
});
