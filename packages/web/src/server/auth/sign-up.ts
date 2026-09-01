import {
  findLiveInvitationByEmail,
  findUserByEmail,
  insertUser,
  isUniqueViolation,
  normaliseEmail,
  revokeInvitation,
  type UserRow,
} from '@thp/db';
import {
  ROLE,
  checkPassword,
  type SessionUser,
  type SignUpRequest,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import { logger } from '@/server/observability/logger';
import { displayNameFor } from './display-name';
import { hashPassword } from './password';
import { issueSession, type IssuedSession } from './session';
import { describeActor, toActor } from './policy';

/**
 * Registering an account (docs/project/prd.md, 3.1.15).
 *
 * Three decisions in here are the whole of what this flow is, and each is a decision rather than a
 * detail:
 *
 * 1. **The role is not in the request.** Every account created here is a Member, named from
 *    {@link ROLE} rather than accepted from a caller, because a self-service route that reads a
 *    role off the wire is an admin-console bypass with a friendly name. An admin changes it
 *    afterwards on `PATCH /api/v1/users/:id`, where the policy module authorises it (3.1.5).
 * 2. **A taken address is told so.** This route answers `email_taken`, which sign-in refuses to
 *    disclose — and that is the correct trade here rather than an inconsistency. A registration
 *    form *cannot* hide it: an address that already has an account cannot be given a second one,
 *    so the alternatives are telling the person plainly or creating nothing and claiming success,
 *    and the second one strands a real member on a screen that has lied to them. Every enumeration
 *    oracle in the product is closed except the one that has to be open for the product to work,
 *    and that one is bounded rather than sealed: the route in front of this module spends a
 *    per-caller and a whole-route budget before it is reached (`sign-up-limits.ts`), which is what
 *    turns the disclosure from something a script works through a list with into something that
 *    answers one address at a time.
 * 3. **An outstanding invitation to the same address is revoked.** The address it was mailed to has
 *    just become an account, so its link can no longer be accepted (the accept path refuses on
 *    `email_taken`, and the unique index refuses underneath that). Revoking turns a pending
 *    invitation that is silently doomed into a revoked one an admin can read — and if it carried a
 *    role above Member, the log line below is what tells them to go and re-assign it.
 *
 * There is no email verification: the product is a private group whose real gate is a person an
 * admin recognises, and an unverified address costs a member a password-reset link they cannot
 * receive rather than costing the product anything.
 */

/** The most a field can be before we stop reading it. A password is a passphrase, not a payload. */
const MAX_FIELD_LENGTH = 512;

/** Deliberately loose — the same shape the invitation route and the seed command accept. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseSignUp(body: unknown): SignUpRequest {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with an email and a password.');
  }
  const { email, password } = body as Partial<SignUpRequest>;

  if (typeof email !== 'string' || email.trim() === '' || email.length > MAX_FIELD_LENGTH) {
    throw ApiError.invalidInput('Give an email address.');
  }
  if (!EMAIL_SHAPE.test(email.trim())) {
    throw ApiError.invalidInput('That is not an email address.');
  }
  if (typeof password !== 'string' || password.length > MAX_FIELD_LENGTH) {
    throw ApiError.weakPassword('Choose a password.');
  }
  return { email: normaliseEmail(email), password };
}

export interface SignUpResult {
  /**
   * The same shape sign-in and invitation-accept return, built by the policy module — so all three
   * ways into the product answer with one payload and the client has one thing to understand.
   */
  readonly user: SessionUser;
  readonly session: IssuedSession;
}

export async function signUp(body: unknown): Promise<SignUpResult> {
  const { email, password } = parseSignUp(body);

  // Checked before the hash so the argon2 work is not spent on an address that cannot have an
  // account. The unique index below is what actually makes two accounts impossible; this is what
  // makes the ordinary case a sentence rather than a `500`.
  if (await findUserByEmail(email)) {
    logger.warn('signup.refused', { action: 'signup', reason: 'address-has-account' });
    throw ApiError.emailTaken('That address already has an account. Sign in instead.');
  }

  const weakness = checkPassword(password, { email });
  if (weakness !== null) throw ApiError.weakPassword(weakness);

  const passwordHash = await hashPassword(password);

  const row = await insertMember(email, passwordHash);

  await retireInvitationFor(email, row.id);

  const session = await issueSession(row.id);
  logger.info('signup.succeeded', {
    actorId: row.id,
    actorEmail: row.email,
    action: 'signup',
    target: `account:${row.id}`,
  });
  return { user: describeActor(toActor(row)), session };
}

/** The insert, and the one refusal it can come back with that is not a bug. */
async function insertMember(email: string, passwordHash: string): Promise<UserRow> {
  try {
    return await insertUser({
      email,
      passwordHash,
      displayName: displayNameFor(email),
      // Named from the enum rather than spelled, which is what tools/role-usage.ts is for: the one
      // place a role is chosen outside the policy module is a constant, not a value off the wire.
      role: ROLE.member,
    });
  } catch (caught) {
    // Two registrations for the same address, in flight at once. The unique index refused the
    // second, and its sender is owed the same sentence the check above would have given them.
    if (isUniqueViolation(caught)) {
      logger.warn('signup.refused', { action: 'signup', reason: 'lost-insert-race' });
      throw ApiError.emailTaken('That address already has an account. Sign in instead.');
    }
    throw caught;
  }
}

/**
 * Close an invitation the new account has just made unacceptable.
 *
 * Best-effort on purpose, and after the account exists rather than before: the registration has
 * already succeeded, and failing it now to tidy a row up would take away an account somebody has
 * from them. A failure is logged and the invitation is left pending, which is the state it would
 * have been in anyway.
 */
async function retireInvitationFor(email: string, userId: string): Promise<void> {
  try {
    const pending = await findLiveInvitationByEmail(email);
    if (pending === null) return;

    await revokeInvitation(pending.id);
    // The role the invitation carried is deliberately **not** applied to the account. It is said
    // here instead, so an admin who invited somebody as an admin and found them signing up
    // themselves has a line to read rather than a silent demotion to discover.
    logger.info('signup.invitation-superseded', {
      actorId: userId,
      action: 'signup',
      target: `invitation:${pending.id}`,
    });
  } catch (caught) {
    logger.warn('signup.invitation-retire-failed', {
      actorId: userId,
      action: 'signup',
      reason: caught instanceof Error ? caught.message : 'unknown',
    });
  }
}
