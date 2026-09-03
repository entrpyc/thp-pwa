import {
  completePasswordReset,
  findLivePasswordResetForUser,
  findPasswordResetWithUser,
  findUserByEmail,
  issuePasswordReset,
  normaliseEmail,
  revokePasswordResetsForUser,
  type PasswordResetRow,
  type UserRow,
} from '@thp/db';
import {
  RESET_PASSWORD_PAGE_PATH,
  RESET_TOKEN_PARAM,
  checkPassword,
  type CompletePasswordResetRequest,
  type PasswordResetPreviewPayload,
  type PasswordResetRequestedPayload,
  type PasswordResetStatus,
  type RequestPasswordResetRequest,
  type SessionUser,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import { hashPassword } from '@/server/auth/password';
import { toActor } from '@/server/auth/policy';
import { describeSessionUser } from '@/server/accounts/session-user';
import { issueSession, type IssuedSession } from '@/server/auth/session';
import { generateToken, hashToken } from '@/server/auth/tokens';
import { readAppOrigin } from '@/server/mail/env';
import { sendMail } from '@/server/mail/mailer';
import { passwordResetMessage } from '@/server/mail/password-reset-message';
import { logger } from '@/server/observability/logger';
import {
  isWithinResendInterval,
  passwordResetExpiryFrom,
} from './window';

/**
 * Requesting, previewing and completing a password reset (docs/project/prd.md, 3.1.6).
 *
 * **The request route answers one payload, always.** Sent, unknown address, deactivated account,
 * malformed input, transport down — every one of them produces the same status, the same body and
 * the same headers. That is not politeness: an honest answer here is an account-enumeration oracle
 * on an unauthenticated route, and it is the same rule sign-in already holds. The consequence is
 * that this module can never tell the caller what it did, so everything it did is in the log
 * instead.
 *
 * Two orderings are decisions rather than style:
 *
 * 1. **A second request revokes the outstanding one**, inside the transaction that issues the new
 *    one, so exactly one link works. Same shape as an invitation resend, same reason.
 * 2. **A send failure revokes the reset it just created.** A row left behind after a failed send
 *    would hold the one-live-reset slot and make the next request wait out the re-send interval for
 *    a token nobody ever received. Nothing is retryable here, because nobody is watching: the
 *    caller has already been told the same thing it would be told on success.
 *
 * **Nothing here logs or returns a raw token.** The only place one appears is the reset URL handed
 * to the mailer.
 */

/** The most a field can be before we stop reading it. A password is a passphrase, not a payload. */
const MAX_FIELD_LENGTH = 512;

/** Deliberately loose — the same shape the invitation route and the seed command accept. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The one answer. Frozen so no caller can decorate it into something that differs per outcome. */
const REQUESTED: PasswordResetRequestedPayload = Object.freeze({ requested: true });

// ---------------------------------------------------------------------------------------------
// Reading a row

/**
 * Pending, expired, used or revoked — computed from the three timestamps, never stored. A stored
 * status is a second source of truth that a clock can make wrong, and it mirrors `invitationStatus`
 * exactly so the two flows cannot come to mean different things by the same four words.
 */
export function passwordResetStatus(
  row: PasswordResetRow,
  now: Date = new Date(),
): PasswordResetStatus {
  if (row.usedAt !== null) return 'used';
  if (row.revokedAt !== null) return 'revoked';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

/**
 * The link the message carries. Built from configuration, never from the request's `Host` header —
 * that header is attacker-controlled, and a link built from it points wherever an attacker likes.
 */
export function resetUrlFor(token: string): string {
  const url = new URL(`${readAppOrigin()}${RESET_PASSWORD_PAGE_PATH}`);
  url.searchParams.set(RESET_TOKEN_PARAM, token);
  return url.toString();
}

// ---------------------------------------------------------------------------------------------
// Requesting

/** `null` for anything that is not an address we would even look up. */
function parseRequestedEmail(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { email } = body as Partial<RequestPasswordResetRequest>;
  if (typeof email !== 'string' || email.trim() === '' || email.length > MAX_FIELD_LENGTH) {
    return null;
  }
  if (!EMAIL_SHAPE.test(email.trim())) return null;
  return normaliseEmail(email);
}

/**
 * Ask for a reset link.
 *
 * Every return below is the same object, and every path that stops early logs why. Read the
 * branches as "what we did", never as "what we said" — what we said is identical throughout.
 */
export async function requestPasswordReset(body: unknown): Promise<PasswordResetRequestedPayload> {
  const email = parseRequestedEmail(body);
  if (email === null) {
    logger.warn('password-reset.request.ignored', { reason: 'malformed-address' });
    return REQUESTED;
  }

  const row = await findUserByEmail(email);
  if (row === null) {
    logger.warn('password-reset.request.ignored', { reason: 'unknown-address' });
    return REQUESTED;
  }
  if (row.deactivatedAt !== null) {
    logger.warn('password-reset.request.ignored', {
      reason: 'account-deactivated',
      actorId: row.id,
    });
    return REQUESTED;
  }

  const outstanding = await findLivePasswordResetForUser(row.id);
  if (outstanding !== null && isWithinResendInterval(outstanding.createdAt)) {
    logger.warn('password-reset.request.ignored', {
      reason: 'within-resend-interval',
      actorId: row.id,
    });
    return REQUESTED;
  }

  await issueAndSend(row);
  return REQUESTED;
}

/**
 * Write the row, then send. Split out so the ordering — and the cleanup on failure — is stated once
 * rather than once per caller.
 */
async function issueAndSend(row: UserRow): Promise<void> {
  const token = generateToken();
  const reset = await issuePasswordReset({
    userId: row.id,
    tokenHash: hashToken(token),
    expiresAt: passwordResetExpiryFrom(),
  });

  logger.info('password-reset.request', {
    actorId: row.id,
    actorEmail: row.email,
    action: 'password-reset.request',
    target: `account:${row.id}`,
    expiresAt: reset.expiresAt.toISOString(),
  });

  try {
    await sendMail(
      passwordResetMessage({
        to: row.email,
        resetUrl: resetUrlFor(token),
        expiresAt: reset.expiresAt,
      }),
    );
  } catch (cause) {
    // Swallowed on purpose. The caller has already been promised nothing, and telling it the send
    // failed would tell it the address exists. The row is revoked so the next request is not made
    // to wait out the re-send interval for a token that was never delivered.
    await revokePasswordResetsForUser(row.id);
    logger.error('password-reset.request.undelivered', {
      actorId: row.id,
      action: 'password-reset.request',
      target: `account:${row.id}`,
      errorMessage: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Previewing and completing

/**
 * Turn a token into the reset and its account, or throw the refusal its holder is entitled to.
 *
 * `reset_expired` is separated from `reset_invalid` here and nowhere else: an expired token is one
 * we issued that ran out of time, and telling its holder so is what lets the screen offer another
 * link instead of saying "wrong". Unknown, malformed, revoked and already-used are one code between
 * them, because distinguishing those would tell a guesser which of their guesses had ever been real.
 *
 * A deactivated account is its own answer again, and for the same reason sign-in gives one: the
 * caller is holding a token that was mailed to that address, so they already know the account
 * exists, and leaving them to guess helps nobody.
 */
async function resolveToken(token: unknown): Promise<{ reset: PasswordResetRow; user: UserRow }> {
  if (typeof token !== 'string' || token.trim() === '' || token.length > MAX_FIELD_LENGTH) {
    throw ApiError.resetInvalid();
  }

  const found = await findPasswordResetWithUser(hashToken(token.trim()));
  if (found === null) throw ApiError.resetInvalid();

  const status = passwordResetStatus(found.reset);
  if (status === 'expired') throw ApiError.resetExpired();
  if (status !== 'pending') throw ApiError.resetInvalid();
  if (found.user.deactivatedAt !== null) throw ApiError.accountDeactivated();

  return found;
}

/**
 * The whole of what an anonymous token holder learns: the address the message was sent to.
 *
 * One field. No id, no role, no display name, and nothing that says anything about the account
 * beyond the fact that this token belongs to it — which whoever is holding the token already knows.
 */
export async function previewPasswordReset(
  token: unknown,
): Promise<PasswordResetPreviewPayload> {
  const { user } = await resolveToken(token);
  return { email: user.email };
}

export interface CompletedPasswordResetResult {
  /**
   * The same shape sign-in returns, built by the policy module — so completing a reset and signing
   * in are the same payload, and the client has one thing to understand rather than two.
   */
  readonly user: SessionUser;
  readonly session: IssuedSession;
}

/**
 * Set the new password, and be signed in by the same response.
 *
 * No sign-in form between the two, for the same reason accepting an invitation has none: somebody
 * who has just proved possession of the address and chosen a password has authenticated, and asking
 * them to do it again is asking them to do the same thing twice.
 *
 * Completing revokes **every other live session** for the account, inside the same transaction as
 * the password change. A reset is what somebody does when they think their password is known, and
 * leaving alive the sessions it was used to open makes the reset cosmetic. The fresh session issued
 * below is why they are not signed out of the browser they are standing in.
 */
export async function completePasswordResetWithPassword(
  body: unknown,
): Promise<CompletedPasswordResetResult> {
  if (typeof body !== 'object' || body === null) throw ApiError.resetInvalid();
  const { token, password } = body as Partial<CompletePasswordResetRequest>;

  const { user: account } = await resolveToken(token);

  if (typeof password !== 'string' || password.length > MAX_FIELD_LENGTH) {
    throw ApiError.weakPassword('Choose a password.');
  }
  // The same module the accept screen and the seed command read, so the three cannot disagree about
  // what a usable password is.
  const weakness = checkPassword(password, { email: account.email });
  if (weakness !== null) throw ApiError.weakPassword(weakness);

  const passwordHash = await hashPassword(password);
  const completed = await completePasswordReset(
    // Re-hashed from what the caller sent rather than carried out of `resolveToken`, so the claim
    // is made against the token actually presented and not against anything derived on the way.
    hashToken((token as string).trim()),
    passwordHash,
  );

  // The conditional claim matched nothing: revoked, expired, used, or the account deactivated
  // between the read above and this write. One code for all four — the holder is not entitled to a
  // race report.
  if (completed === null) throw ApiError.resetInvalid();

  const session = await issueSession(completed.user.id);
  logger.info('password-reset.complete', {
    actorId: completed.user.id,
    actorEmail: completed.user.email,
    action: 'password-reset.complete',
    target: `account:${completed.user.id}`,
  });

  return { user: await describeSessionUser(toActor(completed.user)), session };
}
