import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Role } from '@thp/shared';
import { normaliseEmail } from './accounts';
import { getDatabase, type DatabaseHandle } from './client';
import { invitation, user } from './schema';
import type { UserRow } from './accounts';

/**
 * Invitation reads and writes.
 *
 * The two properties worth naming here, because both are held by SQL rather than by the caller
 * remembering to check:
 *
 * 1. **An invitation is accepted at most once.** {@link acceptInvitation} does not read-then-write.
 *    It updates conditionally — `where token_hash = … and accepted_at is null and revoked_at is
 *    null and expires_at > now()` — and creates the account inside the same transaction, so two
 *    simultaneous accepts of one token produce one account and one refusal, not two accounts.
 * 2. **The window is compared by Postgres.** Every `expires_at` comparison is against `now()` in
 *    the database, exactly as `session` does it, so expiry cannot drift with an application
 *    server's clock.
 */

export interface InvitationRow {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly tokenHash: string;
  readonly invitedBy: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly acceptedAt: Date | null;
}

export interface NewInvitation {
  readonly email: string;
  readonly role: Role;
  readonly tokenHash: string;
  readonly invitedBy: string | null;
  readonly expiresAt: Date;
}

/**
 * Insert an invitation. Throws on `invitation_live_email_unique` when the address already has one
 * that is neither revoked nor accepted — which is the refusal the API turns into "use resend".
 */
export async function insertInvitation(
  input: NewInvitation,
  handle: DatabaseHandle = getDatabase(),
): Promise<InvitationRow> {
  const rows = await handle.db
    .insert(invitation)
    .values({ ...input, email: normaliseEmail(input.email) })
    .returning();
  const row = rows[0] as InvitationRow | undefined;
  if (!row) throw new Error('insertInvitation returned no row');
  return row;
}

/** The invitation behind a token hash, whatever state it is in. `null` if no such token exists. */
export async function findInvitationByTokenHash(
  tokenHash: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<InvitationRow | null> {
  const rows = await handle.db
    .select()
    .from(invitation)
    .where(eq(invitation.tokenHash, tokenHash))
    .limit(1);
  return (rows[0] as InvitationRow | undefined) ?? null;
}

export async function findInvitationById(
  id: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<InvitationRow | null> {
  const rows = await handle.db.select().from(invitation).where(eq(invitation.id, id)).limit(1);
  return (rows[0] as InvitationRow | undefined) ?? null;
}

/**
 * The invitation for an address that is neither revoked nor accepted — the same set the partial
 * unique index covers, so what this finds is exactly what an insert would collide with.
 */
export async function findLiveInvitationByEmail(
  email: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<InvitationRow | null> {
  const rows = await handle.db
    .select()
    .from(invitation)
    .where(
      and(
        sql`lower(${invitation.email}) = ${normaliseEmail(email)}`,
        isNull(invitation.revokedAt),
        isNull(invitation.acceptedAt),
      ),
    )
    .limit(1);
  return (rows[0] as InvitationRow | undefined) ?? null;
}

/** Every invitation, newest first. Step 5 renders this; step 3 only has to be able to answer it. */
export async function listInvitations(
  handle: DatabaseHandle = getDatabase(),
): Promise<InvitationRow[]> {
  const rows = await handle.db.select().from(invitation).orderBy(desc(invitation.createdAt));
  return rows as InvitationRow[];
}

/**
 * Revoke, if there is anything to revoke. Returns the updated row, or `null` when the invitation
 * does not exist, is already revoked, or has been accepted — an accepted invitation is history and
 * revoking it would be a lie about what happened.
 */
export async function revokeInvitation(
  id: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<InvitationRow | null> {
  const rows = await handle.db
    .update(invitation)
    .set({ revokedAt: new Date() })
    .where(and(eq(invitation.id, id), isNull(invitation.revokedAt), isNull(invitation.acceptedAt)))
    .returning();
  return (rows[0] as InvitationRow | undefined) ?? null;
}

export interface AcceptInvitationInput {
  readonly tokenHash: string;
  readonly passwordHash: string;
  readonly displayName: string;
}

export interface AcceptedInvitation {
  readonly invitation: InvitationRow;
  readonly user: UserRow;
}

/**
 * Mark the invitation accepted and create the account it was for, in **one transaction**.
 *
 * Returns `null` when the conditional update matched nothing — unknown token, revoked, expired, or
 * already accepted. The caller decides which of those to tell the holder, from a separate read;
 * this function's job is to make the transition happen at most once.
 *
 * The account's email and role are taken from the row inside the transaction, never from the
 * caller, so nothing on the wire can influence what role the new account gets.
 */
export async function acceptInvitation(
  input: AcceptInvitationInput,
  handle: DatabaseHandle = getDatabase(),
): Promise<AcceptedInvitation | null> {
  return handle.db.transaction(async (tx) => {
    const claimed = await tx
      .update(invitation)
      .set({ acceptedAt: new Date() })
      .where(
        and(
          eq(invitation.tokenHash, input.tokenHash),
          isNull(invitation.revokedAt),
          isNull(invitation.acceptedAt),
          sql`${invitation.expiresAt} > now()`,
        ),
      )
      .returning();

    const claimedRow = claimed[0] as InvitationRow | undefined;
    if (!claimedRow) return null;

    const { email, role } = claimedRow;
    const created = await tx
      .insert(user)
      .values({
        email: normaliseEmail(email),
        passwordHash: input.passwordHash,
        displayName: input.displayName,
        role,
      })
      .returning();

    const createdRow = created[0] as UserRow | undefined;
    // Unreachable in practice — `returning()` on a successful insert always yields a row. Throwing
    // rather than returning `null` keeps the transaction from committing a claimed invitation with
    // no account behind it.
    if (!createdRow) throw new Error('acceptInvitation created no account');
    return { invitation: claimedRow, user: createdRow };
  });
}
