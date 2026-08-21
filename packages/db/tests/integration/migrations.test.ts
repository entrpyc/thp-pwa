import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import { MIGRATIONS_DIR, runMigrations } from '@thp/db';
import { JOB_STATUSES } from '@thp/shared';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

interface Journal {
  readonly entries: readonly { readonly idx: number; readonly tag: string }[];
}

const journal = JSON.parse(
  readFileSync(resolve(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
) as Journal;

interface MigrationRow {
  readonly id: number;
  readonly hash: string;
  readonly created_at: string;
}

/** Every table's column set, so "this migration touched nothing else" is comparable rather than argued. */
async function readColumnSets(url: string): Promise<Map<string, string[]>> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
      order by table_name, column_name
    `;
    const sets = new Map<string, string[]>();
    for (const row of rows) {
      sets.set(row.table_name, [...(sets.get(row.table_name) ?? []), row.column_name]);
    }
    return sets;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * A migrations folder holding only the first `count` entries of the real journal.
 *
 * This is what makes "existing tables are untouched" a **before and after** rather than a list of
 * columns somebody typed out and could equally have typed out wrong. The database is migrated to
 * the state before the new migration, photographed, migrated the rest of the way, and photographed
 * again.
 */
function migrationsFolderUpTo(count: number): string {
  const folder = mkdtempSync(resolve(tmpdir(), 'thp-migrations-'));
  mkdirSync(resolve(folder, 'meta'), { recursive: true });
  const entries = journal.entries.slice(0, count);
  for (const entry of entries) {
    copyFileSync(resolve(MIGRATIONS_DIR, `${entry.tag}.sql`), resolve(folder, `${entry.tag}.sql`));
  }
  writeFileSync(
    resolve(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
  );
  return folder;
}

/**
 * How many migrations precede the one tagged `tag`.
 *
 * Named rather than counted back from the end: a before-and-after comparison has to pin the
 * migration it is about, or the next migration to arrive silently re-points every one of them at
 * itself and the comparisons quietly become vacuous.
 */
function journalCountBefore(tag: string): number {
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  if (index < 0) throw new Error(`no migration is tagged ${tag}`);
  return index;
}

async function readMigrationRows(url: string): Promise<MigrationRow[]> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return (await sql<MigrationRow[]>`
      select id, hash, created_at::text as created_at
      from drizzle.__drizzle_migrations
      order by id
    `) as unknown as MigrationRow[];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe('migrations apply to an empty database by one command', () => {
  let target: ThrowawayDatabase;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'migrations');
  }, 60_000);

  afterAll(async () => {
    await target?.drop();
  }, 60_000);

  it('has at least one migration to apply — otherwise this suite is vacuous', () => {
    expect(journal.entries.length).toBeGreaterThan(0);
  });

  it('leaves a recorded, ordered migration state', async () => {
    await runMigrations({ url: target.url });
    const rows = await readMigrationRows(target.url);

    expect(rows).toHaveLength(journal.entries.length);
    expect(rows.map((row) => row.id)).toEqual([...rows.map((row) => row.id)].sort((a, b) => a - b));
    expect(rows.every((row) => row.hash.length > 0)).toBe(true);
  });

  it('is a no-op the second time', async () => {
    const before = await readMigrationRows(target.url);
    await expect(runMigrations({ url: target.url })).resolves.toBeUndefined();
    const after = await readMigrationRows(target.url);
    expect(after).toEqual(before);
  });

  it('applied the schema the migration describes', async () => {
    const sql = postgres(target.url, { max: 1, onnotice: () => {} });
    try {
      const types = await sql<{ typname: string }[]>`
        select typname from pg_type
        where typname in ('user_role', 'pipeline_step', 'job_status')
        order by typname
      `;
      expect(types.map((row) => row.typname)).toEqual(['job_status', 'pipeline_step', 'user_role']);

      // Tables arrive with the ticket that uses them. Ticket 2 added accounts and sessions, ticket 3
      // invitations, ticket 4 password resets, Story 2 Ticket 01 `recording` and Ticket 02 `job` —
      // `transcript`, `segment` and the rest are still ahead.
      const tables = await sql<{ tablename: string }[]>`
        select tablename from pg_tables where schemaname = 'public' order by tablename
      `;
      expect(tables.map((row) => row.tablename)).toEqual([
        'invitation',
        'job',
        'password_reset',
        'recording',
        'session',
        'user',
      ]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

/**
 * The `recording` table, asserted by its **exact column set**.
 *
 * Exact rather than "contains", because what is absent is the design.
 * docs/epics/epic-core-listening/architecture.md § Extension points names `processed_media_key` as
 * the seam audio processing attaches to, `series_id` belongs to Story 6, and no `duration` exists
 * because nothing in this epic inspects the media. A nullable column added "for later" is how
 * deferral quietly stops being deferral — and a `toContain` assertion would not notice one arriving.
 */
describe('the recording table, and nothing beside it', () => {
  let target: ThrowawayDatabase;
  /** Column sets as of the migration *before* this one, and after it. */
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'recording_migration');

    const priorCount = journalCountBefore('0004_recordings');
    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount) });
    before = await readColumnSets(target.url);

    await runMigrations({ url: target.url });
    after = await readColumnSets(target.url);
  }, 120_000);

  afterAll(async () => {
    await target?.drop();
  }, 60_000);

  it('did not exist before this migration and does after — otherwise the comparison is vacuous', () => {
    expect(before.has('recording')).toBe(false);
    expect(after.has('recording')).toBe(true);
  });

  it('carries exactly these columns, and none of the deferred ones', () => {
    expect(after.get('recording')).toEqual([
      'created_at',
      'description',
      'id',
      'original_media_key',
      'published_at',
      'recorded_at',
      'title',
    ]);

    for (const deferred of ['duration', 'processed_media_key', 'series_id']) {
      expect(after.get('recording'), `${deferred} is deferred and must not exist`).not.toContain(
        deferred,
      );
    }
  });

  it('records the date recorded as a date, not a timestamp', async () => {
    const sql = postgres(target.url, { max: 1, onnotice: () => {} });
    try {
      const [row] = await sql<{ data_type: string }[]>`
        select data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'recording' and column_name = 'recorded_at'
      `;
      expect(row?.data_type).toBe('date');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('leaves every table that already existed exactly as it was', () => {
    // Every account table, column for column, before and after. The migration adds a table; it
    // alters nothing.
    for (const [table, columns] of before) {
      expect(after.get(table), `${table} changed`).toEqual(columns);
    }
    expect([...before.keys()].sort()).toEqual([
      'invitation',
      'password_reset',
      'session',
      'user',
    ]);
  });
});

/**
 * The `job` table — the ledger and the queue at once (Story 2 Ticket 02).
 *
 * Asserted the same way `recording` is, and for the same reason: by its **exact column set**,
 * before and after, so a column added "for later" is a failing test rather than a comment nobody
 * reads. Two properties beyond the columns are asserted here rather than in the query layer,
 * because they are properties of the *database* — the four statuses the enum admits, and the rule
 * that a recording has at most one unfinished job per step. Neither can be true by convention.
 */
describe('the job ledger, and nothing beside it', () => {
  let target: ThrowawayDatabase;
  /** Column sets as of the migration *before* this one, and after it. */
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;
  let sql: ReturnType<typeof postgres>;
  let recordings = 0;

  /** A recording of its own per test, so no test can be affected by another's rows. */
  async function newRecording(): Promise<string> {
    recordings += 1;
    const key = `recordings/job-ledger-${recordings}.mp3`;
    const [row] = await sql<{ id: string }[]>`
      insert into recording (original_media_key, title, recorded_at)
      values (${key}, 'A teaching', '2026-01-04')
      returning id
    `;
    return row?.id as string;
  }

  /** Enqueue by hand. The query layer that will do this properly is the next slice of the ticket. */
  async function insertJob(
    recordingId: string,
    step: string,
    status: string,
    attempt: number,
  ): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into job (recording_id, step, status, attempt, correlation_id)
      values (
        ${recordingId},
        ${step}::pipeline_step,
        ${status}::job_status,
        ${attempt},
        'a-known-correlation-id'
      )
      returning id
    `;
    return row?.id as string;
  }

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'job_migration');

    const priorCount = journalCountBefore('0005_job_ledger');
    await runMigrations({ url: target.url, migrationsFolder: migrationsFolderUpTo(priorCount) });
    before = await readColumnSets(target.url);

    await runMigrations({ url: target.url });
    after = await readColumnSets(target.url);

    sql = postgres(target.url, { max: 2, onnotice: () => {} });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('did not exist before this migration and does after — otherwise the comparison is vacuous', () => {
    expect(before.has('job')).toBe(false);
    expect(after.has('job')).toBe(true);
  });

  it('carries exactly these columns, and none of the deferred ones', () => {
    expect(after.get('job')).toEqual([
      'attempt',
      'correlation_id',
      'enqueued_at',
      'error',
      'finished_at',
      'id',
      'provider_meta',
      'recording_id',
      'started_at',
      'status',
      'step',
    ]);

    // A retry count, a schedule, a worker's name and a payload all belong to things this epic
    // deliberately does not have: automatic retry, docs/project/prd.md 3.21.3's batching, a worker
    // pool, and a job whose input is not the recording it names.
    for (const deferred of ['max_attempts', 'scheduled_for', 'worker_id', 'payload', 'updated_at']) {
      expect(after.get('job'), `${deferred} is deferred and must not exist`).not.toContain(deferred);
    }
  });

  it('admits exactly the four statuses, in the order the shared constant declares them', async () => {
    const rows = await sql<{ enumlabel: string }[]>`
      select enumlabel
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'job_status'
      order by pg_enum.enumsortorder
    `;
    expect(rows.map((row) => row.enumlabel)).toEqual([...JOB_STATUSES]);
  });

  it('records what a provider reports as jsonb, since no two report the same shape', async () => {
    const [row] = await sql<{ data_type: string }[]>`
      select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'job' and column_name = 'provider_meta'
    `;
    expect(row?.data_type).toBe('jsonb');
  });

  it('leaves the outcome columns empty at enqueue', async () => {
    const id = await insertJob(await newRecording(), 'transcribe', 'pending', 1);
    const [row] = await sql<
      {
        status: string;
        started_at: Date | null;
        finished_at: Date | null;
        error: string | null;
        provider_meta: unknown;
      }[]
    >`select status, started_at, finished_at, error, provider_meta from job where id = ${id}`;

    expect(row?.status).toBe('pending');
    expect(row?.started_at).toBeNull();
    expect(row?.finished_at).toBeNull();
    expect(row?.error).toBeNull();
    expect(row?.provider_meta).toBeNull();
  });

  it('refuses a job that belongs to no recording', async () => {
    await expect(
      sql`
        insert into job (recording_id, step, status, attempt, correlation_id)
        values (null, 'transcribe', 'pending', 1, 'a-known-correlation-id')
      `,
    ).rejects.toThrow();

    await expect(
      insertJob('00000000-0000-0000-0000-000000000000', 'transcribe', 'pending', 1),
    ).rejects.toThrow();
  });

  it('refuses a second unfinished job for the same recording and step', async () => {
    const recordingId = await newRecording();
    await insertJob(recordingId, 'transcribe', 'pending', 1);

    await expect(insertJob(recordingId, 'transcribe', 'pending', 2)).rejects.toThrow();
    // Claimed counts as unfinished too — otherwise a second worker could start the step that is
    // already running.
    await expect(insertJob(recordingId, 'transcribe', 'running', 2)).rejects.toThrow();

    // A different step of the same recording is a different pair, and is not blocked.
    await expect(insertJob(recordingId, 'generate_draft', 'pending', 1)).resolves.toBeTruthy();
  });

  it('accepts a second job once the earlier one has finished', async () => {
    const recordingId = await newRecording();
    const first = await insertJob(recordingId, 'transcribe', 'pending', 1);
    await sql`update job set status = 'succeeded', finished_at = now() where id = ${first}`;

    // The ledger is append-only: the re-run is a new row, so a succeeded row must not block it.
    const second = await insertJob(recordingId, 'transcribe', 'pending', 2);
    expect(second).not.toBe(first);

    // And a failed one must not either — a human re-enqueueing the step is the whole of
    // docs/project/prd.md 3.21.2.4.
    await sql`update job set status = 'failed', finished_at = now() where id = ${second}`;
    await expect(insertJob(recordingId, 'transcribe', 'pending', 3)).resolves.toBeTruthy();
  });

  it('leaves every table that already existed exactly as it was', () => {
    for (const [table, columns] of before) {
      expect(after.get(table), `${table} changed`).toEqual(columns);
    }
    expect([...before.keys()].sort()).toEqual([
      'invitation',
      'password_reset',
      'recording',
      'session',
      'user',
    ]);
  });
});
