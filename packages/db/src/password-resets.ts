import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDatabase, type DatabaseHandle } from './client';
import { passwordReset, session, user } from './schema';
import type { UserRow } from './accounts';

/**
 * Password-reset reads and writes.
 *
 * Three properties this module exists to hold, all of them held by SQL rather than by the caller
 * remembering to check:
 *
 * 1. **The raw token is never stored.** Callers hand in a hash; a lookup by the raw link value
 *    finds nothing. The same rule `session` and `invitation` already live under.
 * 2. **A reset is completed at most once.** {@link completePasswordReset} does not read-then-write:
 *    it claims the row conditionally — `where token_hash = … and used_at is null and revoked_at is
 *    null and expires_at > now()` — and changes the password and revokes the account's sessions
 *    inside the same transaction. Two simultaneous completions of one token produce one password
 *    change and one refusal.
 * 3. **The window is compared by Postgres.** Every `expires_at` comparison is against `now()` in
 *    the database, so expiry cannot drift with an application server's clock.
 */

export interface PasswordResetRow {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface NewPasswordReset {
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

/**
 * The reset for an account that is neither used nor revoked — the same set the partial unique index
 * covers, so what this finds is exactly what an insert would collide with.
 */
export async function findLivePasswordResetForUser(
  userId: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<PasswordResetRow | null> {
  const rows = await handle.db
    .select()
    .from(passwordReset)
    .where(
      and(
        eq(passwordReset.userId, userId),
        isNull(passwordReset.usedAt),
        isNull(passwordReset.revokedAt),
      ),
    )
    .limit(1);
  return (rows[0] as PasswordResetRow | undefined) ?? null;
}

/** The reset behind a token hash together with the account it belongs to, in one read. */
export async function findPasswordResetWithUser(
  tokenHash: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<{ reset: PasswordResetRow; user: UserRow } | null> {
  const rows = await handle.db
    .select()
    .from(passwordReset)
    .innerJoin(user, eq(passwordReset.userId, user.id))
    .where(eq(passwordReset.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0] as { password_reset: PasswordResetRow; user: UserRow } | undefined;
  return row ? { reset: row.password_reset, user: row.user } : null;
}

/**
 * Revoke whatever live reset an account has, then issue a fresh one — **in one transaction, in that
 * order**, because the partial unique index permits exactly one live reset per account.
 *
 * The ordering is also the security property: after a second request the previous link is dead, so
 * exactly one link works. It is the same shape as an invitation resend, for the same reason.
 */
export async function issuePasswordReset(
  input: NewPasswordReset,
  handle: DatabaseHandle = getDatabase(),
): Promise<PasswordResetRow> {
  return handle.db.transaction(async (tx) => {
    await tx
      .update(passwordReset)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(passwordReset.userId, input.userId),
          isNull(passwordReset.usedAt),
          isNull(passwordReset.revokedAt),
        ),
      );

    const rows = await tx.insert(passwordReset).values(input).returning();
    const row = rows[0] as PasswordResetRow | undefined;
    if (!row) throw new Error('issuePasswordReset returned no row');
    return row;
  });
}

/** Revoke every live reset an account has. Called when the account is deactivated. */
export async function revokePasswordResetsForUser(
  userId: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<number> {
  const rows = await handle.db
    .update(passwordReset)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(passwordReset.userId, userId),
        isNull(passwordReset.usedAt),
        isNull(passwordReset.revokedAt),
      ),
    )
    .returning({ id: passwordReset.id });
  return rows.length;
}

export interface CompletedPasswordReset {
  readonly reset: PasswordResetRow;
  readonly user: UserRow;
}

/**
 * Claim the token, set the new password, and end every session the account has — **in one
 * transaction**.
 *
 * Returns `null` when the conditional update matched nothing: unknown token, revoked, expired,
 * already used, or the account deactivated between the request and here. The caller decides which
 * of those the holder is told, from a separate read; this function's job is to make the transition
 * happen at most once.
 *
 * Revoking the sessions is part of the same transaction rather than a follow-up call, because a
 * reset that changed the password and then failed to end the sessions it was used to open is a
 * reset that did nothing. The caller issues a fresh session afterwards, so the person is not signed
 * out of the browser they are standing in.
 */
export async function completePasswordReset(
  tokenHash: string,
  passwordHash: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<CompletedPasswordReset | null> {
  return handle.db.transaction(async (tx) => {
    // Locked first, so the account cannot be deactivated between the check below and the write.
    // Reading before writing anything is what lets a refusal leave the token unburned: a reset
    // refused because the account was deactivated has changed nothing, so nothing has to be undone.
    const found = await tx
      .select()
      .from(passwordReset)
      .innerJoin(user, eq(passwordReset.userId, user.id))
      .where(eq(passwordReset.tokenHash, tokenHash))
      .limit(1)
      .for('update');

    const row = found[0] as { password_reset: PasswordResetRow; user: UserRow } | undefined;
    if (!row) return null;
    if (row.user.deactivatedAt !== null) return null;

    const claimed = await tx
      .update(passwordReset)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordReset.tokenHash, tokenHash),
          isNull(passwordReset.usedAt),
          isNull(passwordReset.revokedAt),
          sql`${passwordReset.expiresAt} > now()`,
        ),
      )
      .returning();

    const claimedRow = claimed[0] as PasswordResetRow | undefined;
    if (!claimedRow) return null;

    const updated = await tx
      .update(user)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(user.id, claimedRow.userId))
      .returning();

    const updatedRow = updated[0] as UserRow | undefined;
    if (!updatedRow) throw new Error('completePasswordReset changed no account');

    await tx
      .update(session)
      .set({ revokedAt: new Date() })
      .where(and(eq(session.userId, claimedRow.userId), isNull(session.revokedAt)));

    return { reset: claimedRow, user: updatedRow };
  });
}
