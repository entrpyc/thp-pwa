import { eq, sql } from 'drizzle-orm';
import type { Role } from '@thp/shared';
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
