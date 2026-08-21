import { findUserByEmail } from '@thp/db';
import type { SignInRequest } from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import { logger } from '@/server/observability/logger';
import { verifyAgainstDecoy, verifyPassword } from './password';
import { issueSession, type IssuedSession } from './session';
import { toActor, type Actor } from './policy';

/**
 * Signing in. Three ways to fail — malformed body, unknown address, wrong password — and **one**
 * answer to all three, because a distinguishable answer is an account-enumeration oracle.
 *
 * Nothing here ever logs the submitted password, and nothing about the failure reaches the caller
 * beyond `invalid_credentials`. The reason *is* logged, server-side, so an admin reading the log
 * can still tell a typo from a probe.
 */

/** The most a body can be before we stop reading it. A password is a passphrase, not a payload. */
const MAX_FIELD_LENGTH = 512;

function parseCredentials(body: unknown): SignInRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const { email, password } = body as { email?: unknown; password?: unknown };
  if (typeof email !== 'string' || typeof password !== 'string') return null;
  if (email.trim() === '' || password === '') return null;
  if (email.length > MAX_FIELD_LENGTH || password.length > MAX_FIELD_LENGTH) return null;
  return { email, password };
}

export interface SignInResult {
  readonly actor: Actor;
  readonly session: IssuedSession;
}

export async function signIn(body: unknown): Promise<SignInResult> {
  const credentials = parseCredentials(body);
  if (credentials === null) {
    logger.warn('signin.refused', { reason: 'malformed-body' });
    throw ApiError.invalidCredentials();
  }

  const row = await findUserByEmail(credentials.email);
  if (row === null) {
    // Spend the same work as a real verification: an identical message returned in a tenth of the
    // time is not an identical answer.
    await verifyAgainstDecoy(credentials.password);
    logger.warn('signin.refused', { reason: 'unknown-email' });
    throw ApiError.invalidCredentials();
  }

  if (!(await verifyPassword(row.passwordHash, credentials.password))) {
    logger.warn('signin.refused', { reason: 'wrong-password', actorId: row.id });
    throw ApiError.invalidCredentials();
  }

  // **After** the password verifies, and only then (docs/prd.md, 3.1.7).
  //
  // A wrong password against a deactivated account answers `invalid_credentials` like any other
  // wrong password, so there is no enumeration leak: reaching this line means the caller already
  // knows the credential and therefore already knows the account exists. Telling them costs
  // nothing and saves a real person twenty minutes of hunting for a typo that does not exist.
  if (row.deactivatedAt !== null) {
    logger.warn('signin.refused', { reason: 'account-deactivated', actorId: row.id });
    throw ApiError.accountDeactivated();
  }

  const session = await issueSession(row.id);
  const actor = toActor(row);
  logger.info('signin.succeeded', { actorId: actor.id });
  return { actor, session };
}
