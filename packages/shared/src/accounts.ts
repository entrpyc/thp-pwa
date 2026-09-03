import type { Role } from './roles';

/**
 * The account-lifecycle wire contract: password reset, deactivation, role change, and the profile
 * fields a person owns.
 *
 * Read by the API, by the two reset screens and by the reset email, so none of the three can invent
 * its own idea of what any of it looks like on the wire.
 *
 * **No shape in this file carries a token**, for the same reason no invitation shape does: a
 * payload type with an optional `token` field is a payload type that will one day carry one. The
 * raw reset token exists in exactly two places — the link in the message, and the body of the
 * complete request — and neither is a representation of a reset.
 *
 * **The avatar arrived with the profile screen.** docs/project/prd.md 3.1.12 names one and
 * core-listening scope plan § Ticket 4 deferred it; the deferral ended when a screen existed to set
 * it from. What travels is never the object key — a `SessionUser` carries a signed URL or `null`
 * (see `auth.ts`), and the two avatar routes below take the same grant → `PUT` → finalise shape a
 * series cover does, so there is one way an image gets into this product rather than two.
 */

/** Paths of the account resource, relative to the `/api/v1` prefix. */
export const USERS_PATH = '/users';

/** Request (`POST`) and preview (`GET`) — two of ticket 4's three unauthenticated routes. */
export const PASSWORD_RESET_PATH = '/auth/password-reset';

/** Completing the reset. The third. */
export const PASSWORD_RESET_COMPLETE_PATH = '/auth/password-reset/complete';

/** Where somebody who cannot sign in asks for a link. On the web origin, not under the API prefix. */
export const FORGOT_PASSWORD_PAGE_PATH = '/forgot-password';

/** The screen a reset link opens. */
export const RESET_PASSWORD_PAGE_PATH = '/reset-password';

/**
 * The admin console, on the web origin rather than under the API prefix.
 *
 * Here beside the other page-path constants rather than in a module of its own: it is the console
 * over exactly the account routes declared above, and one string does not earn a file.
 */
export const ADMIN_PAGE_PATH = '/admin';

/**
 * The profile screen, on the web origin — where a person edits the two things about their account
 * that are theirs to edit (docs/project/prd.md 3.1.12): the name others see, and the picture beside it.
 */
export const PROFILE_PAGE_PATH = '/profile';

/**
 * The signed-in account's avatar: `PUT` points it at an uploaded image, `DELETE` takes it away.
 *
 * `me` rather than an id, exactly as the playback-speed route is `me`: the only avatar anybody may
 * set is their own, and a path that could name somebody else's would need an ownership rule to
 * refuse what it should never have been able to express. An admin ends accounts and changes roles
 * and does not touch the face on one — which is 3.1.12's rule for the name, applied to the picture.
 */
export const AVATAR_PATH = `${USERS_PATH}/me/avatar`;

/** Permission to send the picture — the grant half of the upload. */
export const AVATAR_UPLOADS_PATH = `${AVATAR_PATH}/uploads`;

/**
 * Body of `POST /api/v1/users/me/avatar/uploads` — the same three fields a series cover's grant
 * takes, meaning the same things: the filename is logged and never used to build the key, and the
 * size is a convenience that fails an oversized request before an upload rather than after one.
 * The vocabulary of accepted formats and the byte ceiling are `artwork.ts`'s, deliberately — a
 * second image vocabulary would be a second thing the screen and the API could disagree about.
 */
export interface AvatarGrantRequest {
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
}

/** Body of `PUT /api/v1/users/me/avatar`. The key from the grant, now with bytes behind it. */
export interface SetAvatarRequest {
  readonly key: string;
}

/** The query parameter the reset link carries the token in. */
export const RESET_TOKEN_PARAM = 'token';

/**
 * The longest a display name may be. A name, not a biography — long enough for a full name in any
 * script, short enough that it cannot be used as a message board.
 */
export const MAX_DISPLAY_NAME_LENGTH = 80;

/**
 * Where a reset is in its life. Derived on read from `expires_at`, `used_at` and `revoked_at`
 * rather than stored — exactly as an invitation's status is, and for the same reason: a stored
 * status is a second source of truth that a clock can make wrong.
 */
export const PASSWORD_RESET_STATUSES = ['pending', 'expired', 'used', 'revoked'] as const;

export type PasswordResetStatus = (typeof PASSWORD_RESET_STATUSES)[number];

export function isPasswordResetStatus(value: unknown): value is PasswordResetStatus {
  return (
    typeof value === 'string' && (PASSWORD_RESET_STATUSES as readonly string[]).includes(value)
  );
}

/** Body of `POST /api/v1/auth/password-reset`. */
export interface RequestPasswordResetRequest {
  readonly email: string;
}

/**
 * Payload of `POST /api/v1/auth/password-reset` — **the same object for every outcome**.
 *
 * An unknown address, a deactivated account, a malformed address and a genuine send all answer with
 * this and nothing else. There is deliberately no field that could differ between them: a payload
 * with a `sent: boolean` in it is an account-enumeration oracle with a friendly name.
 */
export interface PasswordResetRequestedPayload {
  readonly requested: true;
}

/**
 * Payload of `GET /api/v1/auth/password-reset?token=…` — the only thing an anonymous holder of a
 * token learns, and the reason a dead link can say "expired" before anyone chooses a password.
 *
 * One field, and it is the address the token was already mailed to.
 */
export interface PasswordResetPreviewPayload {
  readonly email: string;
}

/** Body of `POST /api/v1/auth/password-reset/complete`. */
export interface CompletePasswordResetRequest {
  readonly token: string;
  readonly password: string;
}

/**
 * An account as an admin is allowed to see it. No password hash, no token of any kind, no avatar.
 *
 * `active` is the derived answer and `deactivatedAt` is the fact behind it, in the same way an
 * invitation carries both its status and its expiry — a console needs to say *when*, and a client
 * must never have to compare a timestamp to a clock to decide whether somebody may sign in.
 */
export interface AccountSummary {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly active: boolean;
  /** ISO 8601, or `null` while the account is active. */
  readonly deactivatedAt: string | null;
  readonly createdAt: string;
}

/** Payload of `GET /api/v1/users`. */
export interface AccountListPayload {
  readonly accounts: readonly AccountSummary[];
}

/**
 * Body of `PATCH /api/v1/users/:id`. Both fields are optional and each is authorised separately:
 * `role` is an admin action on somebody else, `displayName` is an owner action on yourself, and the
 * policy module answers both.
 */
export interface UpdateAccountRequest {
  readonly role?: Role;
  readonly displayName?: string;
}

/**
 * `null` when the display name is acceptable, otherwise one sentence saying what is wrong with it.
 *
 * In `shared` rather than in the API for the same reason the password rules are: a screen has to be
 * able to show the rule before somebody fails it, and one statement of it means the screen and the
 * API cannot disagree.
 */
export function checkDisplayName(displayName: string): string | null {
  const trimmed = displayName.trim();
  if (trimmed === '') return 'Give a name people will see. It cannot be blank.';
  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    return `That is ${trimmed.length} characters; names go up to ${MAX_DISPLAY_NAME_LENGTH}.`;
  }
  return null;
}

/**
 * Up to two initials — what a circle holds for a person who has set no picture
 * (docs/project/prd.md 3.1.12: the avatar is optional, so this is the ordinary state).
 *
 * The first word's initial and the last word's, so "Ada Byron King" reads `AK` rather than `AB`;
 * one initial for a one-word name; `?` for a name that is somehow blank. In `shared` because the
 * note card and the profile screen both draw it, and two drawings of one name would be two answers
 * to which letters a person is.
 */
export function monogramFor(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  const last = words[words.length - 1];
  const letters = [first, ...(last !== undefined && last !== first ? [last] : [])]
    .filter((word): word is string => word !== undefined)
    .map((word) => word.slice(0, 1));
  return letters.join('').toUpperCase() || '?';
}
