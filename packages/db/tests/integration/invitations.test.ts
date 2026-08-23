import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import { ROLE } from '@thp/shared';
import {
  acceptInvitation,
  createDatabase,
  findInvitationByTokenHash,
  findLiveInvitationByEmail,
  insertInvitation,
  insertUser,
  listInvitations,
  revokeInvitation,
  runMigrations,
  type DatabaseHandle,
} from '@thp/db';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * The `invitation` table, asserted against a freshly migrated database rather than against the
 * Drizzle schema — the schema is what we meant, the migration is what a deployment will have.
 *
 * The properties worth holding in SQL rather than in the API are the ones a second code path could
 * otherwise break: one live invitation per address, a token stored only as a digest, and an
 * acceptance that happens at most once.
 */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function inSevenDays(): Date {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

describe('the invitation schema', () => {
  let target: ThrowawayDatabase;
  let sql: postgres.Sql;
  let handle: DatabaseHandle;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'invitations');
    await runMigrations({ url: target.url });
    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    handle = createDatabase({ url: target.url, max: 4 });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  it('gives `invitation` exactly the columns ticket 3 owns', async () => {
    const columns = await sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable
      from information_schema.columns
      where table_schema = 'public' and table_name = 'invitation'
      order by column_name
    `;

    expect(columns.map((column) => column.column_name)).toEqual([
      'accepted_at',
      'created_at',
      'email',
      'expires_at',
      'id',
      'invited_by',
      'revoked_at',
      'role',
      'token_hash',
    ]);

    // The three transition timestamps are the only nullable columns: everything else is a fact
    // known at the moment the row is written. `invited_by` is nullable too, because the admin who
    // issued it can be removed and the record of what happened should survive that.
    const nullable = columns
      .filter((column) => column.is_nullable === 'YES')
      .map((column) => column.column_name);
    expect(nullable.sort()).toEqual(['accepted_at', 'invited_by', 'revoked_at']);
  });

  it('reads the existing user_role enum rather than declaring a second copy of it', async () => {
    const [column] = await sql<{ udt_name: string }[]>`
      select udt_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'invitation' and column_name = 'role'
    `;
    expect(column?.udt_name).toBe('user_role');

    // And there is exactly one `user_role` in the database — no second copy under another name —
    // so "declared once" is a fact rather than a naming coincidence. The list grows as later
    // tickets add their own enums; what must never grow is the number of role enums.
    const enums = await sql<{ typname: string }[]>`
      select typname from pg_type where typtype = 'e' order by typname
    `;
    expect(enums.map((row) => row.typname)).toEqual([
      'job_status',
      'note_visibility',
      'pipeline_step',
      'review_kind',
      'review_status',
      'user_role',
    ]);
    expect(enums.filter((row) => row.typname.includes('role'))).toHaveLength(1);
  });

  it('stores the email normalised, whatever casing it was written with', async () => {
    const row = await insertInvitation(
      { email: '  MiXeD.Case@Example.TEST ', role: ROLE.member, tokenHash: HASH_A, invitedBy: null, expiresAt: inSevenDays() },
      handle,
    );
    expect(row.email).toBe('mixed.case@example.test');
  });

  it('refuses a second live invitation for the same address, in any casing', async () => {
    const email = `dup-${Date.now().toString(36)}@example.test`;
    await insertInvitation(
      { email, role: ROLE.member, tokenHash: `c${'0'.repeat(63)}`, invitedBy: null, expiresAt: inSevenDays() },
      handle,
    );

    // Refused by the database, not by the caller remembering to look first.
    await expect(
      insertInvitation(
        { email: email.toUpperCase(), role: ROLE.member, tokenHash: `d${'0'.repeat(63)}`, invitedBy: null, expiresAt: inSevenDays() },
        handle,
      ),
    ).rejects.toThrow();
  });

  it('frees the address again once the invitation is revoked', async () => {
    const email = `revoked-${Date.now().toString(36)}@example.test`;
    const first = await insertInvitation(
      { email, role: ROLE.member, tokenHash: `e${'0'.repeat(63)}`, invitedBy: null, expiresAt: inSevenDays() },
      handle,
    );
    await revokeInvitation(first.id, handle);

    // This is what makes resend legal: revoke the old, then issue the new.
    const second = await insertInvitation(
      { email, role: ROLE.member, tokenHash: `f${'0'.repeat(63)}`, invitedBy: null, expiresAt: inSevenDays() },
      handle,
    );
    expect(second.id).not.toBe(first.id);
    expect((await findLiveInvitationByEmail(email, handle))?.id).toBe(second.id);
  });

  it('frees the address again once the invitation is accepted', async () => {
    const email = `accepted-${Date.now().toString(36)}@example.test`;
    const tokenHash = `1${'0'.repeat(63)}`;
    await insertInvitation(
      { email, role: ROLE.member, tokenHash, invitedBy: null, expiresAt: inSevenDays() },
      handle,
    );
    await acceptInvitation({ tokenHash, passwordHash: 'not-a-real-hash', displayName: 'Accepted' }, handle);

    await expect(
      insertInvitation(
        { email, role: ROLE.member, tokenHash: `2${'0'.repeat(63)}`, invitedBy: null, expiresAt: inSevenDays() },
        handle,
      ),
    ).resolves.toBeDefined();
  });

  it('never stores the raw token — a lookup by it finds nothing', async () => {
    const rawToken = 'this-is-what-the-link-would-carry';
    const stored = `3${'0'.repeat(63)}`;
    const row = await insertInvitation(
      { email: `hashed-${Date.now().toString(36)}@example.test`, role: ROLE.member, tokenHash: stored, invitedBy: null, expiresAt: inSevenDays() },
      handle,
    );

    expect(row.tokenHash).not.toBe(rawToken);
    expect(await findInvitationByTokenHash(rawToken, handle)).toBeNull();
    expect((await findInvitationByTokenHash(stored, handle))?.id).toBe(row.id);

    // And the raw value is nowhere in the row at all, under any column.
    const [persisted] = await sql<{ row: string }[]>`
      select invitation::text as row from invitation where id = ${row.id}
    `;
    expect(persisted?.row ?? '').not.toContain(rawToken);
  });

  it('accepts a token at most once, creating exactly one account', async () => {
    const email = `once-${Date.now().toString(36)}@example.test`;
    const tokenHash = `4${'0'.repeat(63)}`;
    await insertInvitation(
      { email, role: ROLE.member, tokenHash, invitedBy: null, expiresAt: inSevenDays() },
      handle,
    );

    const first = await acceptInvitation(
      { tokenHash, passwordHash: 'not-a-real-hash', displayName: 'Once' },
      handle,
    );
    expect(first).not.toBeNull();

    const second = await acceptInvitation(
      { tokenHash, passwordHash: 'not-a-real-hash', displayName: 'Once again' },
      handle,
    );
    expect(second).toBeNull();

    const accounts = await sql<{ count: string }[]>`
      select count(*)::text as count from "user" where lower(email) = ${email}
    `;
    expect(accounts[0]?.count).toBe('1');
  });

  it('refuses to accept an expired token, and leaves the row untouched', async () => {
    const email = `expired-${Date.now().toString(36)}@example.test`;
    const tokenHash = `5${'0'.repeat(63)}`;
    await insertInvitation(
      { email, role: ROLE.member, tokenHash, invitedBy: null, expiresAt: new Date(Date.now() - 1000) },
      handle,
    );

    expect(
      await acceptInvitation({ tokenHash, passwordHash: 'x', displayName: 'Nope' }, handle),
    ).toBeNull();

    const found = await findInvitationByTokenHash(tokenHash, handle);
    expect(found?.acceptedAt).toBeNull();
    const accounts = await sql<{ count: string }[]>`
      select count(*)::text as count from "user" where lower(email) = ${email}
    `;
    expect(accounts[0]?.count).toBe('0');
  });

  it('rolls the whole acceptance back when the account cannot be created', async () => {
    const email = `taken-${Date.now().toString(36)}@example.test`;
    const tokenHash = `6${'0'.repeat(63)}`;
    await insertInvitation(
      { email, role: ROLE.member, tokenHash, invitedBy: null, expiresAt: inSevenDays() },
      handle,
    );
    // The address gains an account between issue and accept — the `user_email_lower_unique` index
    // is what stops a second one, and the transaction is what stops a half-done acceptance.
    await insertUser(
      { email, passwordHash: 'not-a-real-hash', displayName: 'Already Here', role: ROLE.member },
      handle,
    );

    await expect(
      acceptInvitation({ tokenHash, passwordHash: 'x', displayName: 'Second' }, handle),
    ).rejects.toThrow();

    // Still pending. A claimed invitation with no account behind it would be unrecoverable.
    expect((await findInvitationByTokenHash(tokenHash, handle))?.acceptedAt).toBeNull();
  });

  it('refuses to revoke an invitation that has been accepted', async () => {
    const email = `history-${Date.now().toString(36)}@example.test`;
    const tokenHash = `7${'0'.repeat(63)}`;
    const row = await insertInvitation(
      { email, role: ROLE.member, tokenHash, invitedBy: null, expiresAt: inSevenDays() },
      handle,
    );
    await acceptInvitation({ tokenHash, passwordHash: 'x', displayName: 'History' }, handle);

    expect(await revokeInvitation(row.id, handle)).toBeNull();
    expect((await findInvitationByTokenHash(tokenHash, handle))?.revokedAt).toBeNull();
  });

  it('lists what has been written, newest first', async () => {
    const rows = await listInvitations(handle);
    expect(rows.length).toBeGreaterThan(1);
    const times = rows.map((row) => row.createdAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});
