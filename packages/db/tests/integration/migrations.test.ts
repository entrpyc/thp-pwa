import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import { MIGRATIONS_DIR, runMigrations } from '@thp/db';
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
        select typname from pg_type where typname in ('user_role', 'pipeline_step') order by typname
      `;
      expect(types.map((row) => row.typname)).toEqual(['pipeline_step', 'user_role']);

      // Tables arrive with the ticket that uses them. Ticket 2 added accounts and sessions, ticket 3
      // invitations, ticket 4 password resets, Story 2 Ticket 01 `recording` — `job`, `transcript`,
      // `segment` and the rest are still ahead.
      const tables = await sql<{ tablename: string }[]>`
        select tablename from pg_tables where schemaname = 'public' order by tablename
      `;
      expect(tables.map((row) => row.tablename)).toEqual([
        'invitation',
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

    const priorCount = journal.entries.length - 1;
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
