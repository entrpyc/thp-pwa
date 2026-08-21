/**
 * The `/api/v1` wire contract. Shared so the client parses exactly what the API promises, and so
 * the envelope cannot be reinvented one route at a time.
 */

/** The versioned prefix every API path sits under. */
export const API_PREFIX = '/api/v1';

/** Request and response header carrying the correlation id. */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Machine-readable failure codes. The code is what a caller branches on; `message` is for a human
 * reading a log or a screen and is never parsed.
 *
 * The three refusal codes are deliberately distinct, because
 * docs/project/architecture.md § Cross-cutting concerns makes error types part of the contract:
 *
 * - `unauthenticated` — no usable session. The caller does not get to learn whether the route even
 *   exists; an unknown path answers this too.
 * - `forbidden` — a real session, but the policy module refused this `(actor, action, resource)`.
 *   A client that shows an admin control to a member sees this, which is the point: the API
 *   refuses, the client only hides.
 * - `invalid_credentials` — sign-in failed. Wrong password, unknown email and malformed input all
 *   answer with this same code and the same message, so the response never discloses whether an
 *   address has an account.
 *
 * Ticket 3 adds six, and the split between them is the point rather than an accident of naming:
 *
 * - `invalid_input` — the request could not be read as what the route accepts. A role nobody
 *   offers, a missing field, a body that is not an object.
 * - `weak_password` — the password was read fine and refused on its merits. Distinct from
 *   `invalid_input` because the accept screen prints the reason beside the field rather than as a
 *   general failure.
 * - `email_taken` — that address already has an account. Only ever returned to an admin, who is
 *   the one person entitled to know it; sign-in still discloses nothing.
 * - `invitation_exists` — that address already has a live invitation. The admin wants resend, not
 *   a second live token.
 * - `invitation_invalid` and `invitation_expired` — deliberately two codes, so a dead link can
 *   say "this expired, ask an admin to send another" rather than "wrong". Unknown, malformed,
 *   revoked and already-accepted are all `invitation_invalid`; only a token that was genuinely
 *   ours and ran out of time is `invitation_expired`.
 *
 * Ticket 4 adds five, and each exists because a screen or an operator has to be able to tell this
 * failure from the one next to it:
 *
 * - `reset_invalid` and `reset_expired` — the same split as the two invitation codes, for the same
 *   reason: an expired reset link is owed "ask for another" rather than "wrong". Unknown,
 *   malformed, revoked and already-used are all `reset_invalid`.
 * - `account_deactivated` — the password was right and the account is no longer active. Returned
 *   **only after the password verifies**, so it discloses nothing to a caller who does not already
 *   know the credential, and a real person is told what happened instead of hunting for a typo
 *   that does not exist.
 * - `account_state_conflict` — deactivating an already-deactivated account, or reactivating an
 *   active one. A conflict rather than a silent success, so an admin console cannot report an
 *   action it did not take.
 * - `last_admin` — refused because the product would be left with no active admin. Distinct from
 *   `forbidden`: the caller *was* permitted, and the refusal names an invariant rather than a
 *   permission. That is what lets the message say "promote someone first" instead of "you may not".
 */
export const API_ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'invalid_credentials',
  'invalid_input',
  'weak_password',
  'email_taken',
  'invitation_exists',
  'invitation_invalid',
  'invitation_expired',
  'reset_invalid',
  'reset_expired',
  'account_deactivated',
  'account_state_conflict',
  'last_admin',
  'not_found',
  'internal_error',
  'service_unavailable',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly correlationId: string;
  };
}

/** A success body is the payload at the top level; a failure body is the error envelope. */
export type ApiResponseBody<TPayload> = TPayload | ApiErrorBody;

export function isApiErrorBody(body: unknown): body is ApiErrorBody {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const { error } = body as { error: unknown };
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string' &&
    typeof (error as { correlationId?: unknown }).correlationId === 'string'
  );
}
