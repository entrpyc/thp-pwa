import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import { runMigrations } from '@thp/db';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * The shape of step 4's table, and the two invariants that are the database's job rather than the
 * application's — asserted against a freshly migrated database rather than against the Drizzle
 * schema, because the schema is what we *meant* and the migration is what a deployment will have.
 */
describe('the password_reset schema', () => {
  let target: ThrowawayDatabase;
  let sql: postgres.Sql;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'resets');
    await runMigrations({ url: target.url });
    sql = postgres(target.url, { max: 2, onnotice: () => {} });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  async function anAccount(email: string): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      insert into "user" (email, password_hash, display_name, role)
      values (${email}, 'argon2-hash-goes-here', 'Somebody', 'member')
      returning id
    `;
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`could not create ${email}`);
    return id;
  }

  it('has a hash column and no column that could hold a raw token', async () => {
    const columns = await sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable
      from information_schema.columns
      where table_schema = 'public' and table_name = 'password_reset'
      order by column_name
    `;

    expect(columns.map((column) => column.column_name)).toEqual([
      'created_at',
      'expires_at',
      'id',
      'revoked_at',
      'token_hash',
      'used_at',
      'user_id',
    ]);
    expect(columns.map((column) => column.column_name)).not.toContain('token');
    // The three facts status is derived from are the three nullable columns plus the window; a
    // stored `status` would be a fourth source of truth a clock could make wrong.
    expect(columns.map((column) => column.column_name)).not.toContain('status');
    expect(
      columns.filter((column) => column.is_nullable === 'YES').map((column) => column.column_name),
    ).toEqual(['revoked_at', 'used_at']);
  });

  it('ties a reset to an account, and lets the account take it with it', async () => {
    const accountId = await anAccount('cascade-reset@example.test');
    await sql`
      insert into password_reset (user_id, token_hash, expires_at)
      values (${accountId}, 'hash-of-a-reset-token', now() + interval '1 hour')
    `;

    await sql`delete from "user" where id = ${accountId}`;
    const remaining = await sql<{ id: string }[]>`
      select id from password_reset where user_id = ${accountId}
    `;
    expect(remaining).toEqual([]);
  });

  it('refuses a second live reset for the same account', async () => {
    const accountId = await anAccount('one-live-reset@example.test');
    await sql`
      insert into password_reset (user_id, token_hash, expires_at)
      values (${accountId}, 'first-reset-hash', now() + interval '1 hour')
    `;

    await expect(
      sql`
        insert into password_reset (user_id, token_hash, expires_at)
        values (${accountId}, 'second-reset-hash', now() + interval '1 hour')
      `,
    ).rejects.toThrow(/duplicate key|unique/i);

    // Revoking the first frees the slot — which is what makes "revoke the old, issue the new" the
    // only legal way to re-send, and therefore what makes "exactly one link works" true.
    await sql`update password_reset set revoked_at = now() where token_hash = 'first-reset-hash'`;
    await sql`
      insert into password_reset (user_id, token_hash, expires_at)
      values (${accountId}, 'second-reset-hash', now() + interval '1 hour')
    `;
    const live = await sql<{ count: string }[]>`
      select count(*)::text as count from password_reset
      where user_id = ${accountId} and used_at is null and revoked_at is null
    `;
    expect(live[0]?.count).toBe('1');
  });
});

describe('deactivation is a timestamp, not a deleted row', () => {
  let target: ThrowawayDatabase;
  let sql: postgres.Sql;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'deactivation');
    await runMigrations({ url: target.url });
    sql = postgres(target.url, { max: 2, onnotice: () => {} });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('leaves the account, its password and everything it authored intact', async () => {
    // docs/prd.md 3.1.7's "its authored content is retained", with the only authored content this
    // slice yet has: the invitations this admin issued.
    const admin = await sql<{ id: string; password_hash: string }[]>`
      insert into "user" (email, password_hash, display_name, role)
      values ('retained@example.test', 'the-original-argon2-hash', 'Retained', 'admin')
      returning id, password_hash
    `;
    const adminId = admin[0]?.id ?? '';
    await sql`
      insert into invitation (email, role, token_hash, invited_by, expires_at)
      values ('invitee@example.test', 'member', 'an-invitation-hash', ${adminId}, now() + interval '7 days')
    `;

    await sql`update "user" set deactivated_at = now() where id = ${adminId}`;

    const after = await sql<{ id: string; password_hash: string; deactivated_at: Date | null }[]>`
      select id, password_hash, deactivated_at from "user" where id = ${adminId}
    `;
    expect(after).toHaveLength(1);
    expect(after[0]?.password_hash).toBe('the-original-argon2-hash');
    expect(after[0]?.deactivated_at).not.toBeNull();

    const invitations = await sql<{ invited_by: string | null }[]>`
      select invited_by from invitation where invited_by = ${adminId}
    `;
    expect(invitations).toHaveLength(1);
    expect(invitations[0]?.invited_by).toBe(adminId);
  });

  it('is reversible by writing null back, with nothing else to restore', async () => {
    const rows = await sql<{ id: string }[]>`
      insert into "user" (email, password_hash, display_name, role)
      values ('reversible@example.test', 'hash', 'Reversible', 'member')
      returning id
    `;
    const id = rows[0]?.id ?? '';
    await sql`update "user" set deactivated_at = now() where id = ${id}`;
    await sql`update "user" set deactivated_at = null where id = ${id}`;

    const after = await sql<{ deactivated_at: Date | null; password_hash: string }[]>`
      select deactivated_at, password_hash from "user" where id = ${id}
    `;
    expect(after[0]?.deactivated_at).toBeNull();
    expect(after[0]?.password_hash).toBe('hash');
  });
});
