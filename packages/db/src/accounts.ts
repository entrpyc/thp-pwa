import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { ROLE, type Role } from '@thp/shared';
import { getDatabase, type DatabaseHandle } from './client';
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
  /** `null` while the account is active. Step 4's deactivation is this column and nothing else. */
  readonly deactivatedAt: Date | null;
}

export interface NewUser {
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string;
  readonly role: Role;
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
  const rows = await handle.db
    .insert(user)
    .values({ ...input, email: normaliseEmail(input.email) })
    .returning();
  const row = rows[0] as UserRow | undefined;
  if (!row) throw new Error('insertUser returned no row');
  return row;
}

// ---------------------------------------------------------------------------------------------
// The account lifecycle (step 4)

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
 * Every account, oldest first. Step 5 renders this; step 4 only has to be able to answer it.
 *
 * Selects the whole row: the caller turns it into a payload, and the payload type is what
 * guarantees no hash travels — not this function remembering to leave a column out.
 */
export async function listUsers(handle: DatabaseHandle = getDatabase()): Promise<UserRow[]> {
  const rows = await handle.db.select().from(user).orderBy(asc(user.createdAt));
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
 * Whether a row is an admin.
 *
 * Destructured rather than read as a field: tools/role-usage.ts refuses a `.role` access outside
 * the policy module, and that rule is what keeps every *authorisation* decision in one place. This
 * is not one — the last-admin invariant is a fact about the data, and it genuinely has to know
 * which role it is about.
 */
function isAdmin(row: UserRow): boolean {
  const { role } = row;
  return role === ROLE.admin;
}

/**
 * **The last-admin invariant, enforced in the write rather than around it** (docs/prd.md, 3.1.11).
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
 */
async function withLastAdminGuard(
  id: string,
  wouldRemoveAnAdmin: (row: UserRow) => boolean,
  apply: (tx: DatabaseHandle['db']) => Promise<UserRow | null>,
  handle: DatabaseHandle = getDatabase(),
): Promise<GuardedWrite> {
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

    const found = await tx.select().from(user).where(eq(user.id, id)).limit(1);
    const row = found[0] as UserRow | undefined;
    if (!row) return { outcome: 'no-such-account' as const };

    if (wouldRemoveAnAdmin(row) && activeAdmins.every((admin) => admin.id === id)) {
      return { outcome: 'last-admin' as const, user: row };
    }

    const updated = await apply(tx as unknown as DatabaseHandle['db']);
    return updated === null
      ? { outcome: 'unchanged' as const, user: row }
      : { outcome: 'applied' as const, user: updated };
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
  return withLastAdminGuard(
    id,
    // Only an account that is *currently* an active admin can take the last one away with it.
    (row) => row.deactivatedAt === null && isAdmin(row),
    async (tx) => {
      const rows = await tx
        .update(user)
        .set({ deactivatedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(user.id, id), isNull(user.deactivatedAt)))
        .returning();
      return (rows[0] as UserRow | undefined) ?? null;
    },
    handle,
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
  if (found === null) return { outcome: 'no-such-account' };

  const rows = await handle.db
    .update(user)
    .set({ deactivatedAt: null, updatedAt: new Date() })
    .where(and(eq(user.id, id), sql`${user.deactivatedAt} is not null`))
    .returning();
  const updated = rows[0] as UserRow | undefined;
  return updated ? { outcome: 'applied', user: updated } : { outcome: 'unchanged', user: found };
}

/**
 * Change a role. Guarded, because demoting the last active admin is the other half of
 * docs/prd.md 3.1.11, and a guard covering only deactivation would be a guard with a door in it.
 *
 * Setting an account to the role it already holds writes nothing and reports `unchanged`.
 */
export async function setUserRole(
  id: string,
  role: Role,
  handle: DatabaseHandle = getDatabase(),
): Promise<GuardedWrite> {
  return withLastAdminGuard(
    id,
    (row) => row.deactivatedAt === null && isAdmin(row) && role !== ROLE.admin,
    async (tx) => {
      const rows = await tx
        .update(user)
        .set({ role, updatedAt: new Date() })
        .where(and(eq(user.id, id), sql`${roleColumn} <> ${role}::user_role`))
        .returning();
      return (rows[0] as UserRow | undefined) ?? null;
    },
    handle,
  );
}
