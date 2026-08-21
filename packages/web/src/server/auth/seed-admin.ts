import { findUserByEmail, insertUser, type DatabaseHandle } from '@thp/db';
import { ROLE, checkPassword } from '@thp/shared';
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

/**
 * The password rules are **not** stated here. They live in `@thp/shared` (`checkPassword`), which
 * step 3's invitation-accept screen and step 4's reset both read, so the three cannot disagree
 * about what a usable password is. Re-exported for the callers that already named it here.
 */
export { MINIMUM_PASSWORD_LENGTH } from '@thp/shared';

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

  // One rule set, named by the variable the operator has to go and change. The message never
  // repeats the password itself — this reason is printed to a terminal and may end up in a log.
  const weakness = checkPassword(password, { email });
  if (weakness !== null) return `SEED_ADMIN_PASSWORD is not usable. ${weakness}`;

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
