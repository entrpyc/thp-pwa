import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import { ROLES } from '@thp/shared';
import { runMigrations } from '@thp/db';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * The shape of the accounts tables, asserted against a freshly migrated database rather than
 * against the Drizzle schema — the schema is what we *meant*, and the migration is what a
 * deployment will actually have.
 */
describe('the accounts schema', () => {
  let target: ThrowawayDatabase;
  let sql: postgres.Sql;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'accounts');
    await runMigrations({ url: target.url });
    sql = postgres(target.url, { max: 2, onnotice: () => {} });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('gives `user` exactly the columns steps 2, 4 and Story 4 Ticket 03 own', async () => {
    const columns = await sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable
      from information_schema.columns
      where table_schema = 'public' and table_name = 'user'
      order by column_name
    `;

    expect(columns.map((column) => column.column_name)).toEqual([
      'created_at',
      'deactivated_at',
      'display_name',
      'email',
      'id',
      'password_hash',
      'preferred_playback_speed',
      'role',
      'updated_at',
    ]);
    // `preferred_playback_speed` arrived with Story 4 Ticket 03, which is the ticket that ships the
    // speed control that writes it — columns arrive with the ticket that uses them. An avatar is
    // still deferred outright, and its absence here is the point: a nullable column "for later" is
    // how deferral quietly stops being deferral.
    for (const absent of ['avatar', 'avatar_url', 'avatar_key', 'image_url']) {
      expect(columns.map((column) => column.column_name)).not.toContain(absent);
    }

    // Deactivation is the only column that may be absent from a row: an account is active by
    // omission, so no existing row had to be given a value when the column arrived.
    const nullable = columns.filter((column) => column.is_nullable === 'YES');
    expect(nullable.map((column) => column.column_name)).toEqual(['deactivated_at']);
  });

  it('migrates every account that already existed to active', async () => {
    // The column arrived on a database that already had rows in it. "Existing rows migrate to
    // null" is what makes the deploy safe, and it is a fact about the default rather than about
    // the application remembering to backfill.
    await sql`
      insert into "user" (email, password_hash, display_name, role)
      values ('pre-existing@example.test', 'hash', 'Pre Existing', 'member')
    `;
    const rows = await sql<{ deactivated_at: Date | null }[]>`
      select deactivated_at from "user" where email = 'pre-existing@example.test'
    `;
    expect(rows[0]?.deactivated_at).toBeNull();
  });

  it('makes role a Postgres enum whose only values are admin and member', async () => {
    const [column] = await sql<{ udt_name: string }[]>`
      select udt_name from information_schema.columns
      where table_schema = 'public' and table_name = 'user' and column_name = 'role'
    `;
    expect(column?.udt_name).toBe('user_role');

    const values = await sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'user_role'
      order by enumsortorder
    `;

    expect(values.map((row) => row.enumlabel)).toEqual([...ROLES]);
    // Not "the database rejects contributor" — simply that it was never one of the values.
    expect(values.map((row) => row.enumlabel)).not.toContain('contributor');
  });

  it('refuses a second account whose address differs only in case', async () => {
    await sql`
      insert into "user" (email, password_hash, display_name, role)
      values ('A@b.com', 'hash', 'First', 'admin')
    `;

    await expect(
      sql`
        insert into "user" (email, password_hash, display_name, role)
        values ('a@B.com', 'hash', 'Second', 'member')
      `,
    ).rejects.toThrow(/duplicate key|unique/i);

    const counted = await sql<{ count: string }[]>`
      select count(*)::text as count from "user" where lower(email) = 'a@b.com'
    `;
    expect(counted[0]?.count).toBe('1');
  });

  it('gives `session` a hash column and no column that could hold a raw token', async () => {
    const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'session'
      order by column_name
    `;

    expect(columns.map((column) => column.column_name)).toEqual([
      'created_at',
      'expires_at',
      'id',
      'last_used_at',
      'revoked_at',
      'token_hash',
      'user_id',
    ]);
    expect(columns.map((column) => column.column_name)).not.toContain('token');
  });

  it('ties a session to an account, and lets the account own its end', async () => {
    const inserted = await sql<{ id: string }[]>`
      insert into "user" (email, password_hash, display_name, role)
      values ('cascade@example.test', 'hash', 'Cascade', 'member')
      returning id
    `;
    const accountId = inserted[0]?.id;
    expect(accountId).toBeTruthy();

    await sql`
      insert into session (user_id, token_hash, expires_at)
      values (${accountId ?? ''}, 'hash-of-a-token', now() + interval '30 days')
    `;

    await sql`delete from "user" where id = ${accountId ?? ''}`;
    const remaining = await sql<{ id: string }[]>`
      select id from session where user_id = ${accountId ?? ''}
    `;
    expect(remaining).toEqual([]);
  });
});
