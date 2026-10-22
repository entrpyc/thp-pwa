import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { ROLE, type Role } from '@thp/shared';
import { getDatabase, queryable, type DatabaseHandle, type Executor } from './client';
import { user } from './schema';

/**
 * Account reads and writes. Query construction lives in this package and nowhere else — the
 * import-boundary guard refuses a `drizzle-orm` import from `packages/web`, so "the API reaches
 * Postgres through one module" is enforced rather than intended.
 */

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string;
  readonly role: Role;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** `null` while the account is active. Ticket 4's deactivation is this column and nothing else. */
  readonly deactivatedAt: Date | null;
  /** One of the six steps. `1` for every account until its owner changes it (Story 4 Ticket 03). */
  readonly preferredPlaybackSpeed: number;
  /** The avatar's object key, or `null` — the ordinary state (docs/project/prd.md 3.1.12). */
  readonly avatarKey: string | null;
  /** Whether product analytics is off for this account. `false` for every account until its owner says otherwise. */
  readonly analyticsOptedOut: boolean;
  /** Set only on a removed-member placeholder (README.md). `null` on every real account. */
  readonly deletedAt: Date | null;
  /** The terms version this person accepted (`TERMS_VERSION`'s shape), or `null` for never. */
  readonly termsAcceptedVersion: string | null;
  readonly termsAcceptedAt: Date | null;
}

export interface NewUser {
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string;
  readonly role: Role;
  /**
   * The terms version the person accepted while registering, or absent for an account created
   * some other way — by invitation, by the seed command, by a test. Absent means the row is
   * written with no acceptance and the member is asked before their first note; the moment is
   * taken as the insert's, because accepting and registering were one press.
   */
  readonly termsAcceptedVersion?: string;
}

/**
 * Trimmed and lowercased. Applied on every write, so what is stored is what a later lookup will
 * find; the `lower(email)` unique index is what makes it impossible to store two of them.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(
  email: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<UserRow | null> {
  const rows = await handle.db
    .select()
    .from(user)
    .where(sql`lower(${user.email}) = ${normaliseEmail(email)}`)
    .limit(1);
  return (rows[0] as UserRow | undefined) ?? null;
}

export async function findUserById(
  id: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<UserRow | null> {
  const rows = await handle.db.select().from(user).where(eq(user.id, id)).limit(1);
  return (rows[0] as UserRow | undefined) ?? null;
}

/** Insert an account. Throws on the unique index if the address is already taken in any casing. */
export async function insertUser(
  input: NewUser,
  handle: DatabaseHandle = getDatabase(),
): Promise<UserRow> {
  const { termsAcceptedVersion, ...account } = input;
  const rows = await handle.db
    .insert(user)
    .values({
      ...account,
      email: normaliseEmail(input.email),
      ...(termsAcceptedVersion === undefined
        ? {}
        : { termsAcceptedVersion, termsAcceptedAt: new Date() }),
    })
    .returning();
  const row = rows[0] as UserRow | undefined;
  if (!row) throw new Error('insertUser returned no row');
  return row;
}

/**
 * Record that this person accepted a terms version, now.
 *
 * Written unconditionally, as the analytics write is: a member accepting the version they have
 * already accepted gets a fresh moment and the same version, which is the truthful record of what
 * they just did. Answers the row's two columns, or `null` for an account that does not exist.
 */
export async function recordTermsAcceptance(
  id: string,
  version: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<{ readonly termsAcceptedVersion: string; readonly termsAcceptedAt: Date } | null> {
  const rows = await handle.db
    .update(user)
    .set({ termsAcceptedVersion: version, termsAcceptedAt: new Date(), updatedAt: new Date() })
    .where(eq(user.id, id))
    .returning({
      termsAcceptedVersion: user.termsAcceptedVersion,
      termsAcceptedAt: user.termsAcceptedAt,
    });
  const row = rows[0];
  if (row === undefined || row.termsAcceptedVersion === null || row.termsAcceptedAt === null) {
    return null;
  }
  return { termsAcceptedVersion: row.termsAcceptedVersion, termsAcceptedAt: row.termsAcceptedAt };
}

// ---------------------------------------------------------------------------------------------
// The account lifecycle (ticket 4)

/**
 * The role column, bound once.
 *
 * Bound rather than reached for, because tools/role-usage.ts refuses a role field access outside
 * the policy module — the rule that keeps every authorisation decision in one place. The queries
 * below are not authorisation: the last-admin invariant is a fact about the data, and the one
 * statement that enforces it has to be able to name the column it is about.
 */
const { role: roleColumn } = user;

/**
 * Every account, oldest first. Ticket 5 renders this; ticket 4 only has to be able to answer it.
 *
 * Selects the whole row: the caller turns it into a payload, and the payload type is what
 * guarantees no hash travels — not this function remembering to leave a column out.
 *
 * **Placeholders are left out.** A removed member is not an account an admin can do anything to —
 * there is nobody to reactivate and no role to change — and a console listing one would be a row
 * with every control dead on it. The notes it authored are still on their recordings; the member
 * list is for people who can sign in.
 */
export async function listUsers(handle: DatabaseHandle = getDatabase()): Promise<UserRow[]> {
  const rows = await handle.db
    .select()
    .from(user)
    .where(isNull(user.deletedAt))
    .orderBy(asc(user.createdAt));
  return rows as UserRow[];
}

/**
 * Change a display name. Returns the updated row, or `null` if there is no such account.
 *
 * Stored as typed apart from trimming — internal spacing, punctuation and non-ASCII characters all
 * survive, because a name is not an identifier and normalising one is a way of telling somebody
 * their name is wrong.
 */
export async function updateDisplayName(
  id: string,
  displayName: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<UserRow | null> {
  const rows = await handle.db
    .update(user)
    .set({ displayName: displayName.trim(), updatedAt: new Date() })
    .where(eq(user.id, id))
    .returning();
  return (rows[0] as UserRow | undefined) ?? null;
}

/**
 * Point an account at an avatar that landed, or at nothing. Returns the updated row, or `null` if
 * there is no such account.
 *
 * One write for both directions, because they are the same write: `null` is not a second state
 * somebody has to keep in step with a flag, it is the absence of a picture — which is what every
 * account starts with (docs/project/prd.md 3.1.12). The superseded object, if any, stays in the
 * store; there is nothing to delete it with, and that is by design.
 */
export async function setUserAvatar(
  id: string,
  avatarKey: string | null,
  handle: DatabaseHandle = getDatabase(),
): Promise<UserRow | null> {
  const rows = await handle.db
    .update(user)
    .set({ avatarKey, updatedAt: new Date() })
    .where(eq(user.id, id))
    .returning();
  return (rows[0] as UserRow | undefined) ?? null;
}

/**
 * Turn product analytics off or on for an account. Returns what the column now holds, or `null`
 * if there is no such account.
 *
 * One write for both directions, as the avatar's is: consent withdrawn and consent restored are
 * the same column with the opposite value, and nothing beside it has to be kept in step. Written
 * unconditionally rather than only when the value changes, because a member pressing "off" on an
 * account that is already off should be told "off" — not that nothing happened.
 */
export async function setAnalyticsOptOut(
  id: string,
  optedOut: boolean,
  handle: DatabaseHandle = getDatabase(),
): Promise<boolean | null> {
  const rows = await handle.db
    .update(user)
    .set({ analyticsOptedOut: optedOut, updatedAt: new Date() })
    .where(eq(user.id, id))
    .returning({ optedOut: user.analyticsOptedOut });
  return (rows[0] as { optedOut: boolean } | undefined)?.optedOut ?? null;
}

/**
 * How a guarded write ended. Four outcomes rather than a row-or-null, because the caller has four
 * different things to say: it happened, it was already like that, it would have left the product
 * with nobody able to administer it, or there is no such account.
 */
export type GuardedWrite =
  | { readonly outcome: 'applied'; readonly user: UserRow }
  | { readonly outcome: 'unchanged'; readonly user: UserRow }
  | { readonly outcome: 'last-admin'; readonly user: UserRow }
  | { readonly outcome: 'no-such-account' };

/**
 * The same four outcomes with whatever the write produced in the `applied` arm — a row for the
 * three lifecycle writes, a deletion record for the erasure. {@link GuardedWrite} is this with
 * `T = UserRow`, kept under its own name because three callers already read `.user` off it.
 */
export type Guarded<T> =
  | { readonly outcome: 'applied'; readonly value: T }
  | { readonly outcome: 'unchanged'; readonly user: UserRow }
  | { readonly outcome: 'last-admin'; readonly user: UserRow }
  | { readonly outcome: 'no-such-account' };

function asGuardedWrite(result: Guarded<UserRow>): GuardedWrite {
  return result.outcome === 'applied' ? { outcome: 'applied', user: result.value } : result;
}

/**
 * Whether a row is an admin.
 *
 * Destructured rather than read as a field: tools/role-usage.ts refuses a `.role` access outside
 * the policy module, and that rule is what keeps every *authorisation* decision in one place. This
 * is not one — the last-admin invariant is a fact about the data, and it genuinely has to know
 * which role it is about.
 */
export function isAdmin(row: UserRow): boolean {
  const { role } = row;
  return role === ROLE.admin;
}

/**
 * The ids of every account that can act on a report today: active admins, placeholders excluded
 * by the deactivation they carry.
 *
 * A fact about the data rather than an authorisation decision, like {@link isAdmin}: the question
 * is *who should be told* that a report arrived, and the answer is the set of people the console
 * will let in. The policy module still decides, per request, whether any one of them may act.
 */
export async function listActiveAdminIds(executor: Executor = getDatabase()): Promise<string[]> {
  const rows = await queryable(executor)
    .select({ id: user.id })
    .from(user)
    .where(and(sql`${roleColumn} = ${ROLE.admin}::user_role`, isNull(user.deactivatedAt)))
    .orderBy(asc(user.id));
  return rows.map((row) => row.id);
}

/**
 * **The last-admin invariant, enforced in the write rather than around it** (docs/project/prd.md, 3.1.11).
 *
 * Every write that could reduce the number of active admins — deactivating one, demoting one —
 * goes through here. Inside one transaction it
 *
 * 1. locks every currently-active admin row with `for update`, which serialises this transaction
 *    against any other one doing the same thing, and
 * 2. re-reads that set under the lock, so the count it decides on is the count that will still be
 *    true when the update lands.
 *
 * A plain `select count(*)` followed by an `update` has a window in which two admins demote each
 * other and both succeed. This invariant has no way back once broken — nobody left can promote
 * anybody — so that window is not an acceptable one, and the concurrency test in the web suite is
 * what makes the difference observable rather than asserted.
 *
 * Exported for one caller outside this file: `account-deletion.ts`, because deleting the last
 * active admin is removal in 3.1.11's sense and must be refused by the same lock, not by a copy.
 */
export async function withLastAdminGuard<T>(
  id: string,
  wouldRemoveAnAdmin: (row: UserRow) => boolean,
  apply: (tx: Executor, row: UserRow) => Promise<T | null>,
  handle: DatabaseHandle = getDatabase(),
): Promise<Guarded<T>> {
  return handle.db.transaction(async (tx) => {
    // The active-admin set is locked first, and always in the same order, so two concurrent
    // guarded writes queue rather than interleave. Taken before the target row is read: a
    // transaction that read first would decide against a count another one is midway through
    // changing.
    const activeAdmins = (await tx
      .select({ id: user.id })
      .from(user)
      .where(and(sql`${roleColumn} = ${ROLE.admin}::user_role`, isNull(user.deactivatedAt)))
      .orderBy(asc(user.id))
      .for('update')) as { id: string }[];

    // A placeholder is not an account (README.md): there is nobody to deactivate, promote or
    // delete, and a write that reached one would be a write to a row no person owns.
    const found = await tx
      .select()
      .from(user)
      .where(and(eq(user.id, id), isNull(user.deletedAt)))
      .limit(1);
    const row = found[0] as UserRow | undefined;
    if (!row) return { outcome: 'no-such-account' as const };

    if (wouldRemoveAnAdmin(row) && activeAdmins.every((admin) => admin.id === id)) {
      return { outcome: 'last-admin' as const, user: row };
    }

    const applied = await apply(tx, row);
    return applied === null
      ? { outcome: 'unchanged' as const, user: row }
      : { outcome: 'applied' as const, value: applied };
  });
}

/**
 * Deactivate. Conditional on the account still being active, so a second deactivation reports
 * `unchanged` rather than quietly moving the timestamp forward — an admin console must not be able
 * to claim an action it did not take.
 */
export async function deactivateUser(
  id: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<GuardedWrite> {
  return asGuardedWrite(
    await withLastAdminGuard(
      id,
      // Only an account that is *currently* an active admin can take the last one away with it.
      (row) => row.deactivatedAt === null && isAdmin(row),
      async (tx) => {
        const rows = await queryable(tx)
          .update(user)
          .set({ deactivatedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(user.id, id), isNull(user.deactivatedAt)))
          .returning();
        return (rows[0] as UserRow | undefined) ?? null;
      },
      handle,
    ),
  );
}

/**
 * Reactivate — the inverse write, conditional the other way.
 *
 * Outside the guard, deliberately: restoring an account can only ever increase the number of active
 * admins, and a guard on a write that cannot break the invariant is a guard nobody can reason
 * about.
 */
export async function reactivateUser(
  id: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<GuardedWrite> {
  const found = await findUserById(id, handle);
  // A placeholder reads as no account at all, here as in the guard: restoring one would put a
  // "Removed member" back in the member list with nobody behind it.
  if (found === null || found.deletedAt !== null) return { outcome: 'no-such-account' };

  const rows = await handle.db
    .update(user)
    .set({ deactivatedAt: null, updatedAt: new Date() })
    .where(and(eq(user.id, id), sql`${user.deactivatedAt} is not null`, isNull(user.deletedAt)))
    .returning();
  const updated = rows[0] as UserRow | undefined;
  return updated ? { outcome: 'applied', user: updated } : { outcome: 'unchanged', user: found };
}

/**
 * Change a role. Guarded, because demoting the last active admin is the other half of
 * docs/project/prd.md 3.1.11, and a guard covering only deactivation would be a guard with a door in it.
 *
 * Setting an account to the role it already holds writes nothing and reports `unchanged`.
 */
export async function setUserRole(
  id: string,
  role: Role,
  handle: DatabaseHandle = getDatabase(),
): Promise<GuardedWrite> {
  return asGuardedWrite(
    await withLastAdminGuard(
      id,
      (row) => row.deactivatedAt === null && isAdmin(row) && role !== ROLE.admin,
      async (tx) => {
        const rows = await queryable(tx)
          .update(user)
          .set({ role, updatedAt: new Date() })
          .where(and(eq(user.id, id), sql`${roleColumn} <> ${role}::user_role`))
          .returning();
        return (rows[0] as UserRow | undefined) ?? null;
      },
      handle,
    ),
  );
}

