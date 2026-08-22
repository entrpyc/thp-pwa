import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  createDatabase,
  insertRecording,
  listVisibleRecordings,
  runMigrations,
  type DatabaseHandle,
} from '@thp/db';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * The `recording` table, asserted against a freshly migrated database rather than against the
 * Drizzle schema — the schema is what we meant, the migration is what a deployment will have.
 *
 * One property is worth holding in SQL rather than in the API, and it is the one a second code path
 * could otherwise break: **one object, one recording.** The API turns the constraint violation into
 * a refusal, but the constraint is what makes "finalise the same key twice" impossible rather than
 * unlikely — a check-then-insert has a window in which two requests both find nothing.
 */
describe('the recording schema', () => {
  let target: ThrowawayDatabase;
  let sql: postgres.Sql;
  let handle: DatabaseHandle;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'recordings');
    await runMigrations({ url: target.url });
    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    handle = createDatabase({ url: target.url, max: 4 });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('writes a row with the two columns nothing yet fills left null', async () => {
    const row = await insertRecording(
      {
        originalMediaKey: 'originals/11111111-1111-4111-8111-111111111111.mp3',
        title: 'The first teaching',
        recordedAt: '2026-03-08',
      },
      handle,
    );

    expect(row.title).toBe('The first teaching');
    // A SQL `date`, so it comes back as the day it was written as — no time zone got involved.
    expect(row.recordedAt).toBe('2026-03-08');
    expect(row.publishedAt).toBeNull();
    expect(row.description).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('refuses a second row carrying the same media key, at the database', async () => {
    const key = 'originals/22222222-2222-4222-8222-222222222222.mp3';
    await insertRecording({ originalMediaKey: key, title: 'First', recordedAt: '2026-03-01' }, handle);

    await expect(
      insertRecording({ originalMediaKey: key, title: 'Second', recordedAt: '2026-03-02' }, handle),
    ).rejects.toThrowError();

    const [count] = await sql<{ n: string }[]>`
      select count(*)::text as n from recording where original_media_key = ${key}
    `;
    expect(count?.n).toBe('1');
  });

  it('lists newest date recorded first, whatever order the rows were written in', async () => {
    const fresh = await createThrowawayDatabase(inject('databaseUrl'), 'recordings_order');
    try {
      await runMigrations({ url: fresh.url });
      const ordered = createDatabase({ url: fresh.url, max: 2 });
      try {
        // Deliberately written middle, oldest, newest.
        for (const [key, day] of [
          ['originals/b.mp3', '2026-02-15'],
          ['originals/a.mp3', '2025-11-30'],
          ['originals/c.mp3', '2026-06-01'],
        ] as const) {
          await insertRecording({ originalMediaKey: key, title: key, recordedAt: day }, ordered);
        }

        // The one read of this table, with the gate open — which is what the console gets.
        expect(
          (await listVisibleRecordings({ includeUnpublished: true }, ordered)).map(
            (row) => row.recordedAt,
          ),
        ).toEqual([
          '2026-06-01',
          '2026-02-15',
          '2025-11-30',
        ]);
      } finally {
        await ordered.close();
      }
    } finally {
      await fresh.drop();
    }
  }, 120_000);
});
