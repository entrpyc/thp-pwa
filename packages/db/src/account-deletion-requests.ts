import { and, eq, isNull } from 'drizzle-orm';
import { getDatabase, type DatabaseHandle } from './client';
import { accountDeletionRequest, user } from './schema';
import type { UserRow } from './accounts';

/**
 * Deletion requests started from outside a session ([3.1.8](docs/project/prd.md)) — the token
 * half of the public flow. `password-resets.ts` one flow over, and deliberately the same shape:
 * issue revokes the outstanding one inside the transaction that writes the new one, so exactly one
 * link works; nothing here ever sees a raw token.
 *
 * There is no `complete` here. Completing a request is deleting the account, which is
 * `deleteUserAccount` in `accounts.ts`; the request row cascades away with the account, which is
 * why the table has no `used_at`.
 */

export interface AccountDeletionRequestRow {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface NewAccountDeletionRequest {
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

/** The outstanding request for this account, or `null`. At most one exists, by the partial index. */
export async function findLiveAccountDeletionRequestForUser(
  userId: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<AccountDeletionRequestRow | null> {
  const rows = await handle.db
    .select()
    .from(accountDeletionRequest)
    .where(and(eq(accountDeletionRequest.userId, userId), isNull(accountDeletionRequest.revokedAt)))
    .limit(1);
  return (rows[0] as AccountDeletionRequestRow | undefined) ?? null;
}

/**
 * The request behind a token and the account it would delete, or `null`. Status is the caller's
 * to derive from the timestamps; this answers what is stored.
 */
export async function findAccountDeletionRequestWithUser(
  tokenHash: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<{ request: AccountDeletionRequestRow; user: UserRow } | null> {
  const rows = await handle.db
    .select()
    .from(accountDeletionRequest)
    .innerJoin(user, eq(accountDeletionRequest.userId, user.id))
    .where(eq(accountDeletionRequest.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0] as
    | { account_deletion_request: AccountDeletionRequestRow; user: UserRow }
    | undefined;
  return row ? { request: row.account_deletion_request, user: row.user } : null;
}

/**
 * Issue a request, revoking any outstanding one in the same transaction — which is what makes
 * "exactly one link works" true rather than usually true, and what keeps the partial unique index
 * from refusing the insert.
 */
export async function issueAccountDeletionRequest(
  input: NewAccountDeletionRequest,
  handle: DatabaseHandle = getDatabase(),
): Promise<AccountDeletionRequestRow> {
  return handle.db.transaction(async (tx) => {
    await tx
      .update(accountDeletionRequest)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(accountDeletionRequest.userId, input.userId), isNull(accountDeletionRequest.revokedAt)),
      );

    const rows = await tx.insert(accountDeletionRequest).values(input).returning();
    const row = rows[0] as AccountDeletionRequestRow | undefined;
    if (!row) throw new Error('issueAccountDeletionRequest returned no row');
    return row;
  });
}

/** Revoke whatever is outstanding. Returns how many were. Called when a send fails. */
export async function revokeAccountDeletionRequestsForUser(
  userId: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<number> {
  const rows = await handle.db
    .update(accountDeletionRequest)
    .set({ revokedAt: new Date() })
    .where(and(eq(accountDeletionRequest.userId, userId), isNull(accountDeletionRequest.revokedAt)))
    .returning({ id: accountDeletionRequest.id });
  return rows.length;
}
