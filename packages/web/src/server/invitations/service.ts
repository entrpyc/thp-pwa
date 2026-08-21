import {
  acceptInvitation as acceptInvitationRow,
  findInvitationById,
  findInvitationByTokenHash,
  findLiveInvitationByEmail,
  findUserByEmail,
  insertInvitation,
  listInvitations,
  normaliseEmail,
  revokeInvitation as revokeInvitationRow,
  type InvitationRow,
} from '@thp/db';
import {
  ACCEPT_INVITATION_PAGE_PATH,
  INVITATION_TOKEN_PARAM,
  checkPassword,
  isRole,
  type InvitationPreviewPayload,
  type InvitationStatus,
  type InvitationSummary,
  type IssueInvitationRequest,
  type SessionUser,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import { hashPassword } from '@/server/auth/password';
import { generateToken, hashToken } from '@/server/auth/tokens';
import { issueSession, type IssuedSession } from '@/server/auth/session';
import { describeActor, toActor, type Actor } from '@/server/auth/policy';
import { readAppOrigin } from '@/server/mail/env';
import { invitationMessage } from '@/server/mail/invitation-message';
import { sendMail } from '@/server/mail/mailer';
import { logger } from '@/server/observability/logger';
import { invitationExpiryFrom } from './window';

/**
 * Issuing, previewing, accepting, revoking and resending an invitation.
 *
 * Two orderings in here are decisions rather than style, and both are about what survives a
 * failure:
 *
 * 1. **The row is written before the message is sent.** A transport failure leaves a pending,
 *    resendable invitation and returns a retryable refusal. Rolling back instead would throw away
 *    the record of an intent the admin already expressed — and resend exists precisely for this.
 * 2. **Resend revokes the old token before issuing the new one**, in that order, because the
 *    partial unique index permits exactly one live invitation per address. That ordering is also
 *    the security property: after a resend the previous link is dead, so an invitation forwarded to
 *    the wrong person cannot be salvaged by anyone but the holder of the newest mail.
 *
 * Every transition logs actor, action and target. The logger supplies the timestamp and the
 * request's correlation id, so one search on that id returns the whole story
 * (docs/architecture.md § Cross-cutting concerns).
 *
 * **Nothing here logs or returns a raw token**; the only place one appears is the accept URL handed
 * to the mailer.
 */

/** The most a field can be before we stop reading it. */
const MAX_FIELD_LENGTH = 512;

/** Deliberately loose — the same shape the seed command accepts. Deliverability is the real test. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------------------------
// Reading a row

/**
 * Pending, expired, revoked or accepted — computed from the three timestamps, never stored. A
 * stored status is a second source of truth that a clock can make wrong.
 */
export function invitationStatus(row: InvitationRow, now: Date = new Date()): InvitationStatus {
  if (row.acceptedAt !== null) return 'accepted';
  if (row.revokedAt !== null) return 'revoked';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

/** The row as an admin is allowed to see it. Carries no token and no hash, by construction. */
export function describeInvitation(row: InvitationRow, now: Date = new Date()): InvitationSummary {
  const { id, email, role } = row;
  return {
    id,
    email,
    role,
    status: invitationStatus(row, now),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The link the message carries. Built from configuration, never from the request's `Host` header —
 * that header is attacker-controlled, and a link built from it points wherever an attacker likes.
 */
export function acceptUrlFor(token: string): string {
  const url = new URL(`${readAppOrigin()}${ACCEPT_INVITATION_PAGE_PATH}`);
  url.searchParams.set(INVITATION_TOKEN_PARAM, token);
  return url.toString();
}

/**
 * A display name for an account created by accepting. The accept screen asks for a password and
 * nothing else — one field is the whole point — so the local part of the invited address stands in
 * until step 4 ships profile editing.
 */
export function displayNameFor(email: string): string {
  const local = email.split('@')[0] ?? email;
  const words = local
    .split(/[._+-]+/)
    .map((word) => word.trim())
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.length === 0 ? email : words.join(' ');
}

// ---------------------------------------------------------------------------------------------
// Issuing

function parseIssueRequest(body: unknown): IssueInvitationRequest {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with an email and a role.');
  }
  const { email, role } = body as { email?: unknown; role?: unknown };

  if (typeof email !== 'string' || email.trim() === '' || email.length > MAX_FIELD_LENGTH) {
    throw ApiError.invalidInput('Give an email address to invite.');
  }
  if (!EMAIL_SHAPE.test(email.trim())) {
    throw ApiError.invalidInput('That is not an email address.');
  }
  // `isRole` is the enum's own guard, so "only the roles this product has are acceptable" is a
  // property of the one place they are declared rather than a second list to keep in step with it.
  if (!isRole(role)) {
    throw ApiError.invalidInput('Pick a role this product has.');
  }
  return { email: normaliseEmail(email), role };
}

export interface IssuedInvitation {
  readonly invitation: InvitationSummary;
}

/**
 * Create the invitation and send the message.
 *
 * Refuses before writing anything when the address already has an account (`email_taken`) or
 * already has a live invitation (`invitation_exists`) — the latter pointing at resend, which is the
 * thing the admin actually wants.
 */
export async function issueInvitation(actor: Actor, body: unknown): Promise<IssuedInvitation> {
  // Destructured rather than read field by field: tools/role-usage.ts refuses a `.role` access
  // outside the policy module, and that rule is what keeps every authorisation decision in one
  // place. Carrying the value is fine; reaching for the field is what it stops.
  const { email, role } = parseIssueRequest(body);

  if (await findUserByEmail(email)) {
    logger.warn('invitation.refused', {
      actorId: actor.id,
      action: 'invitation.issue',
      target: `invitation:${email}`,
      reason: 'address-has-account',
    });
    throw ApiError.emailTaken(
      'That address already has an account. Invitations are for addresses that do not.',
    );
  }

  if (await findLiveInvitationByEmail(email)) {
    logger.warn('invitation.refused', {
      actorId: actor.id,
      action: 'invitation.issue',
      target: `invitation:${email}`,
      reason: 'live-invitation-exists',
    });
    throw ApiError.invitationExists(
      'That address already has an open invitation. Resend it to issue a fresh link.',
    );
  }

  const row = await createAndSend(actor, email, role, 'invitation.issue');
  return { invitation: describeInvitation(row) };
}

/**
 * Write the row, then send. Shared by issue and resend so the two cannot drift on the order they do
 * it in, on the window they set, or on what they log.
 */
async function createAndSend(
  actor: Actor,
  email: string,
  role: IssueInvitationRequest['role'],
  action: 'invitation.issue' | 'invitation.resend',
): Promise<InvitationRow> {
  const token = generateToken();
  const row = await insertInvitation({
    email,
    role,
    tokenHash: hashToken(token),
    invitedBy: actor.id,
    expiresAt: invitationExpiryFrom(),
  });

  logger.info(action, {
    actorId: actor.id,
    actorEmail: actor.email,
    action,
    target: `invitation:${row.id}`,
    email: row.email,
    expiresAt: row.expiresAt.toISOString(),
  });

  // Throws `service_unavailable` on a transport failure. The row above stays exactly where it is,
  // which is what makes the refusal honestly retryable.
  await sendMail(
    invitationMessage({
      to: row.email,
      invitedByName: actor.displayName,
      acceptUrl: acceptUrlFor(token),
      expiresAt: row.expiresAt,
    }),
  );

  return row;
}

// ---------------------------------------------------------------------------------------------
// Listing, revoking, resending

export async function listAllInvitations(actor: Actor): Promise<InvitationSummary[]> {
  const rows = await listInvitations();
  const now = new Date();
  logger.info('invitation.list', {
    actorId: actor.id,
    action: 'invitation.list',
    target: 'invitation:*',
    count: rows.length,
  });
  return rows.map((row) => describeInvitation(row, now));
}

/**
 * The row, if it is still open to being acted on. An accepted invitation is history — revoking or
 * resending it would be a lie about what happened — and a revoked one has nothing left to revoke.
 */
function requireOpen(row: InvitationRow | null): InvitationRow {
  if (row === null) throw ApiError.notFound('No such invitation.');
  const status = invitationStatus(row);
  if (status === 'accepted') {
    throw ApiError.invitationInvalid('That invitation has been accepted. It is an account now.');
  }
  if (status === 'revoked') {
    throw ApiError.invitationInvalid('That invitation has already been revoked.');
  }
  return row;
}

export async function revokeInvitationById(actor: Actor, id: string): Promise<InvitationSummary> {
  requireOpen(await findInvitationById(id));

  const revoked = await revokeInvitationRow(id);
  // Lost a race with another admin, or with an acceptance, between the read and the update.
  if (revoked === null) throw ApiError.invitationInvalid('That invitation is no longer open.');

  logger.info('invitation.revoke', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'invitation.revoke',
    target: `invitation:${revoked.id}`,
    email: revoked.email,
  });
  return describeInvitation(revoked);
}

/**
 * A fresh token, a fresh 7-day window, and the previous link dead.
 *
 * Revoke first, then issue: the partial unique index allows one live invitation per address, so the
 * order is forced — and it is the order that gives the property worth having, which is that after a
 * resend exactly one link works.
 */
export async function resendInvitationById(actor: Actor, id: string): Promise<InvitationSummary> {
  const existing = requireOpen(await findInvitationById(id));
  const { email, role } = existing;

  const revoked = await revokeInvitationRow(id);
  if (revoked === null) throw ApiError.invitationInvalid('That invitation is no longer open.');

  const row = await createAndSend(actor, email, role, 'invitation.resend');
  return describeInvitation(row);
}

// ---------------------------------------------------------------------------------------------
// Previewing and accepting

/**
 * Turn a token into the row behind it, or throw the refusal its holder is entitled to.
 *
 * `invitation_expired` is separated from `invitation_invalid` here and nowhere else: an expired
 * token is one we issued that ran out of time, and telling its holder so is what lets the screen
 * say "ask an admin for a new one" instead of "wrong". Unknown, malformed, revoked and
 * already-accepted are one code between them, because distinguishing those would tell a guesser
 * which of their guesses had ever been real.
 */
async function resolveToken(token: unknown): Promise<InvitationRow> {
  if (typeof token !== 'string' || token.trim() === '' || token.length > MAX_FIELD_LENGTH) {
    throw ApiError.invitationInvalid();
  }

  const row = await findInvitationByTokenHash(hashToken(token.trim()));
  if (row === null) throw ApiError.invitationInvalid();

  const status = invitationStatus(row);
  if (status === 'expired') throw ApiError.invitationExpired();
  if (status !== 'pending') throw ApiError.invitationInvalid();
  return row;
}

/** The whole of what an anonymous token holder learns. Two fields, and no account fields at all. */
export async function previewInvitation(token: unknown): Promise<InvitationPreviewPayload> {
  const { email, role } = await resolveToken(token);
  return { email, role };
}

export interface AcceptedInvitationResult {
  /**
   * The same shape sign-in returns, built by the policy module — so the accept response and the
   * sign-in response are the same payload, and the client has one thing to understand rather than
   * two. It is also the only module allowed to read a role off a row (tools/role-usage.ts).
   */
  readonly user: SessionUser;
  readonly session: IssuedSession;
}

/**
 * Set a password, get an account and a session in the same response.
 *
 * There is no sign-in form between the two — docs/slice-prd.md § Slice flows → A says the invitee
 * "sets a password → signs in", and a screen that hands somebody an account and then asks them to
 * authenticate against it has made them do the same thing twice.
 */
export async function acceptInvitationWithPassword(
  body: unknown,
): Promise<AcceptedInvitationResult> {
  if (typeof body !== 'object' || body === null) throw ApiError.invitationInvalid();
  const { token, password } = body as { token?: unknown; password?: unknown };

  const row = await resolveToken(token);

  if (typeof password !== 'string' || password.length > MAX_FIELD_LENGTH) {
    throw ApiError.weakPassword('Choose a password.');
  }
  const weakness = checkPassword(password, { email: row.email });
  if (weakness !== null) throw ApiError.weakPassword(weakness);

  // Between issue and here, the address may have gained an account another way. Checked before the
  // hash so the work is not spent, and enforced underneath by the unique index, which is what
  // actually makes two accounts impossible.
  if (await findUserByEmail(row.email)) {
    throw ApiError.emailTaken('That address already has an account. Sign in instead.');
  }

  const passwordHash = await hashPassword(password);
  const accepted = await acceptInvitationRow({
    // Re-hashed from what the caller sent rather than carried out of `resolveToken`, so the claim
    // is made against the token actually presented and not against anything derived on the way.
    tokenHash: hashToken((token as string).trim()),
    passwordHash,
    displayName: displayNameFor(row.email),
  });

  // The conditional update matched nothing: revoked, expired or accepted between the read above and
  // this write. One code for all three — the holder is not entitled to a race report.
  if (accepted === null) throw ApiError.invitationInvalid();

  const session = await issueSession(accepted.user.id);
  logger.info('invitation.accept', {
    actorId: accepted.user.id,
    actorEmail: accepted.user.email,
    action: 'invitation.accept',
    target: `invitation:${accepted.invitation.id}`,
  });

  return { user: describeActor(toActor(accepted.user)), session };
}
