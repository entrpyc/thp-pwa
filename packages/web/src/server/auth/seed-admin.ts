import { findUserByEmail, insertUser, normaliseEmail, type DatabaseHandle } from '@thp/db';
import { ROLE } from '@thp/shared';
import { hashPassword } from './password';

/**
 * Creating the first admin.
 *
 * A command, not a migration: a migration file lives in version control forever, and a credential
 * that has ever been committed is a credential that has leaked. Reading it from the environment
 * means the password exists on the host and in the operator's password manager, and nowhere else.
 *
 * Idempotent, and idempotent in the strict sense — running it again against an existing account
 * does *not* reset the password. A seeder that silently re-seeds is a back door: anyone who can run
 * the deploy can take over the account.
 */

/** Long enough that argon2's cost matters. Nothing shorter is worth seeding as an admin. */
export const MINIMUM_PASSWORD_LENGTH = 12;

export interface SeedAdminInput {
  readonly email: string | undefined;
  readonly displayName: string | undefined;
  readonly password: string | undefined;
}

export type SeedAdminOutcome =
  | { readonly status: 'created'; readonly email: string; readonly id: string }
  | { readonly status: 'exists'; readonly email: string; readonly id: string }
  | { readonly status: 'refused'; readonly reason: string };

function validate(input: SeedAdminInput): { email: string; displayName: string; password: string } | string {
  const email = (input.email ?? '').trim();
  const displayName = (input.displayName ?? '').trim();
  const password = input.password ?? '';

  if (email === '') return 'SEED_ADMIN_EMAIL is not set.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return `SEED_ADMIN_EMAIL is not an email address: ${email}`;
  if (displayName === '') return 'SEED_ADMIN_DISPLAY_NAME is not set.';
  if (password === '') return 'SEED_ADMIN_PASSWORD is not set.';
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    return `SEED_ADMIN_PASSWORD is ${password.length} characters; at least ${MINIMUM_PASSWORD_LENGTH} are required.`;
  }
  if (password.trim() === '') return 'SEED_ADMIN_PASSWORD is only whitespace.';
  if (password.toLowerCase().includes('password')) {
    return 'SEED_ADMIN_PASSWORD contains "password". Pick something a list would not.';
  }
  if (normaliseEmail(email) === password.toLowerCase()) {
    return 'SEED_ADMIN_PASSWORD is the email address.';
  }
  return { email, displayName, password };
}

export async function seedAdmin(
  input: SeedAdminInput,
  handle?: DatabaseHandle,
): Promise<SeedAdminOutcome> {
  const checked = validate(input);
  if (typeof checked === 'string') return { status: 'refused', reason: checked };

  const existing = handle
    ? await findUserByEmail(checked.email, handle)
    : await findUserByEmail(checked.email);
  if (existing) return { status: 'exists', email: existing.email, id: existing.id };

  const values = {
    email: checked.email,
    passwordHash: await hashPassword(checked.password),
    displayName: checked.displayName,
    role: ROLE.admin,
  };
  const created = handle ? await insertUser(values, handle) : await insertUser(values);
  return { status: 'created', email: created.email, id: created.id };
}
