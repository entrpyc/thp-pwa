import {
  findAccountDeletionRequestWithUser,
  findLiveAccountDeletionRequestForUser,
  findUserByEmail,
  issueAccountDeletionRequest,
  normaliseEmail,
  revokeAccountDeletionRequestsForUser,
  type AccountDeletionRequestRow,
  type UserRow,
} from '@thp/db';
import {
  DELETE_ACCOUNT_PAGE_PATH,
  DELETION_TOKEN_PARAM,
  type AccountDeletedPayload,
  type AccountDeletionPreviewPayload,
  type AccountDeletionRequestedPayload,
  type AccountDeletionStatus,
  type CompleteAccountDeletionRequest,
  type RequestAccountDeletionRequest,
} from '@thp/shared';
import { eraseAccount, parsePassword, requireCurrentPassword } from '@/server/accounts/deletion';
import { ApiError } from '@/server/api/errors';
import { toActor } from '@/server/auth/policy';
import { generateToken, hashToken } from '@/server/auth/tokens';
import { readAppOrigin } from '@/server/mail/env';
import { sendMail } from '@/server/mail/mailer';
import { accountDeletionMessage } from '@/server/mail/account-deletion-message';
import { logger } from '@/server/observability/logger';

/**
 * **Starting account deletion from outside a session** ([3.1.8](docs/project/prd.md)) — the
 * flow behind the public request page Apple 5.1.1(v) and Google Play require, for a person who
 * uninstalled the app and still wants to be gone.
 *
 * The password-reset flow's three movements, one resource over, and the same two rules carried
 * across without weakening:
 *
 * 1. **The request route answers one payload, always.** Sent, unknown address, deactivated or
 *    placeholder account, malformed input, transport down — the same status, body and headers.
 *    An unauthenticated route that said otherwise is an enumeration oracle.
 * 2. **Completing needs the current password**, not only the token. A reset link proves the inbox
 *    and lets its holder *choose* a password; a deletion link proving only the inbox would let
 *    whoever reads a forwarded message delete somebody's account. The link gets the person to the
 *    page; the password is what deletes. A deactivated account may still be deleted this way —
 *    deactivation is an admin ending access, and the person's right to be gone survives it.
 *
 * The erasure itself is `server/accounts/deletion.ts`'s {@link eraseAccount}, shared with the
 * signed-in door, so there is one audit line and one answer whichever way the person came.
 */

/** The most a field can be before we stop reading it. */
const MAX_FIELD_LENGTH = 512;

/** Deliberately loose — the same shape the reset and invitation routes accept. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * One hour, and a minute between messages — the reset's two windows, for the reset's reasons: the
 * window only has to cover the walk to the inbox, and a database check on the outstanding
 * request's age removes the cheapest version of mailing an address on a loop.
 */
export const ACCOUNT_DELETION_LIFETIME_MS = 60 * 60 * 1000;
export const ACCOUNT_DELETION_RESEND_INTERVAL_MS = 60 * 1000;

/** The one answer. Frozen so no caller can decorate it into something that differs per outcome. */
const REQUESTED: AccountDeletionRequestedPayload = Object.freeze({ requested: true });

/** Pending, expired or revoked — computed from the timestamps, never stored. */
export function accountDeletionStatus(
  row: AccountDeletionRequestRow,
  now: Date = new Date(),
): AccountDeletionStatus {
  if (row.revokedAt !== null) return 'revoked';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

/** Built from configuration, never from the request's `Host` header, which is attacker-controlled. */
export function deletionUrlFor(token: string): string {
  const url = new URL(`${readAppOrigin()}${DELETE_ACCOUNT_PAGE_PATH}`);
  url.searchParams.set(DELETION_TOKEN_PARAM, token);
  return url.toString();
}

// ---------------------------------------------------------------------------------------------
// Requesting

function parseRequestedEmail(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { email } = body as Partial<RequestAccountDeletionRequest>;
  if (typeof email !== 'string' || email.trim() === '' || email.length > MAX_FIELD_LENGTH) {
    return null;
  }
  if (!EMAIL_SHAPE.test(email.trim())) return null;
  return normaliseEmail(email);
}

/**
 * Ask for a deletion link. Every return is the same object; every early stop logs why.
 */
export async function requestAccountDeletion(
  body: unknown,
): Promise<AccountDeletionRequestedPayload> {
  const email = parseRequestedEmail(body);
  if (email === null) {
    logger.warn('account-deletion.request.ignored', { reason: 'malformed-address' });
    return REQUESTED;
  }

  const row = await findUserByEmail(email);
  if (row === null || row.deletedAt !== null) {
    logger.warn('account-deletion.request.ignored', { reason: 'unknown-address' });
    return REQUESTED;
  }

  const outstanding = await findLiveAccountDeletionRequestForUser(row.id);
  if (
    outstanding !== null &&
    accountDeletionStatus(outstanding) === 'pending' &&
    Date.now() - outstanding.createdAt.getTime() < ACCOUNT_DELETION_RESEND_INTERVAL_MS
  ) {
    logger.warn('account-deletion.request.ignored', {
      reason: 'within-resend-interval',
      actorId: row.id,
    });
    return REQUESTED;
  }

  await issueAndSend(row);
  return REQUESTED;
}

/** Write the row, then send; a failed send revokes the row so the next request is not made to wait. */
async function issueAndSend(row: UserRow): Promise<void> {
  const token = generateToken();
  const request = await issueAccountDeletionRequest({
    userId: row.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ACCOUNT_DELETION_LIFETIME_MS),
  });

  logger.info('account-deletion.request', {
    actorId: row.id,
    action: 'account-deletion.request',
    target: `account:${row.id}`,
    expiresAt: request.expiresAt.toISOString(),
  });

  try {
    await sendMail(
      accountDeletionMessage({
        to: row.email,
        deletionUrl: deletionUrlFor(token),
        expiresAt: request.expiresAt,
      }),
    );
  } catch (cause) {
    // Swallowed on purpose: the caller has already been promised nothing, and telling it the send
    // failed would tell it the address exists.
    await revokeAccountDeletionRequestsForUser(row.id);
    logger.error('account-deletion.request.undelivered', {
      actorId: row.id,
      action: 'account-deletion.request',
      target: `account:${row.id}`,
      errorMessage: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Previewing and completing

/**
 * Turn a token into the request and its account, or throw the refusal its holder is entitled to.
 * `deletion_expired` is the only distinguished failure; unknown, malformed and revoked are one code.
 */
async function resolveToken(
  token: unknown,
): Promise<{ request: AccountDeletionRequestRow; user: UserRow }> {
  if (typeof token !== 'string' || token.trim() === '' || token.length > MAX_FIELD_LENGTH) {
    throw ApiError.deletionInvalid();
  }
  const found = await findAccountDeletionRequestWithUser(hashToken(token.trim()));
  if (found === null) throw ApiError.deletionInvalid();

  const status = accountDeletionStatus(found.request);
  if (status === 'expired') throw ApiError.deletionExpired();
  if (status !== 'pending') throw ApiError.deletionInvalid();
  return found;
}

/** The whole of what an anonymous token holder learns: the address the message was sent to. */
export async function previewAccountDeletion(
  token: unknown,
): Promise<AccountDeletionPreviewPayload> {
  const { user } = await resolveToken(token);
  return { email: user.email };
}

/**
 * Finish: the token names the account, the password proves the person, and the erasure is the
 * same one the signed-in route runs. A refusal — wrong password, last active admin — leaves the
 * token live, so the person can fix what refused and press the same link again inside the hour.
 */
export async function completeAccountDeletion(body: unknown): Promise<AccountDeletedPayload> {
  if (typeof body !== 'object' || body === null) throw ApiError.deletionInvalid();
  const { token } = body as Partial<CompleteAccountDeletionRequest>;
  const { user } = await resolveToken(token);

  const password = parsePassword(body);
  await requireCurrentPassword(toActor(user), user, password, 'account.delete');
  return eraseAccount(user, 'token');
}
