import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDatabase, type DatabaseHandle } from './client';
import { session, user } from './schema';
import type { UserRow } from './accounts';

/**
 * Session reads and writes.
 *
 * Two properties this module exists to hold:
 *
 * 1. **The raw token is never stored.** Callers hand in a hash; a lookup by the raw cookie value
 *    finds nothing.
 * 2. **The account is re-read on every request.** {@link findLiveSessionByTokenHash} joins `user`,
 *    so a role change or (from step 4) a deactivation takes effect on the next request rather than
 *    at the next sign-in. Nothing about the user is trusted from the cookie.
 */

export interface SessionRow {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface LiveSession {
  readonly session: SessionRow;
  readonly user: UserRow;
}

export interface NewSession {
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export async function insertSession(
  input: NewSession,
  handle: DatabaseHandle = getDatabase(),
): Promise<SessionRow> {
  const rows = await handle.db.insert(session).values(input).returning();
  const row = rows[0] as SessionRow | undefined;
  if (!row) throw new Error('insertSession returned no row');
  return row;
}

/**
 * The session behind a cookie, with its account — or `null` if there is no such session, it was
 * revoked, or it has expired. The expiry comparison is made by Postgres against `now()`, so it
 * cannot drift with the application server's clock.
 */
export async function findLiveSessionByTokenHash(
  tokenHash: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<LiveSession | null> {
  const rows = await handle.db
    .select()
    .from(session)
    .innerJoin(user, eq(session.userId, user.id))
    .where(
      and(
        eq(session.tokenHash, tokenHash),
        isNull(session.revokedAt),
        sql`${session.expiresAt} > now()`,
      ),
    )
    .limit(1);

  const row = rows[0] as { session: SessionRow; user: UserRow } | undefined;
  return row ? { session: row.session, user: row.user } : null;
}

/**
 * End a session server-side. Idempotent, and returns whether it changed anything — replaying a
 * signed-out cookie must not resurrect it.
 */
export async function revokeSessionByTokenHash(
  tokenHash: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<boolean> {
  const rows = await handle.db
    .update(session)
    .set({ revokedAt: new Date() })
    .where(and(eq(session.tokenHash, tokenHash), isNull(session.revokedAt)))
    .returning({ id: session.id });
  return rows.length > 0;
}

/** Roll the window forward on use. Callers throttle this — see the session module in the API. */
export async function touchSession(
  id: string,
  expiresAt: Date,
  handle: DatabaseHandle = getDatabase(),
): Promise<void> {
  await handle.db.update(session).set({ lastUsedAt: new Date(), expiresAt }).where(eq(session.id, id));
}
