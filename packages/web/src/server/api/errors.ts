import type { ApiErrorCode } from '@thp/shared';

/**
 * A failure a route means to return. Anything else that escapes a handler is a bug and becomes a
 * `500` with a generic message — see route.ts.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }

  /**
   * No usable session. Deliberately says nothing about whether the route exists, which is what
   * stops an anonymous caller from mapping the API by probing for `not_found`.
   */
  static unauthenticated(message = 'This request requires a signed-in session.'): ApiError {
    return new ApiError('unauthenticated', 401, message);
  }

  /** A real session, refused by the policy module. Distinct from `unauthenticated` on purpose. */
  static forbidden(message = 'This account is not permitted to do that.'): ApiError {
    return new ApiError('forbidden', 403, message);
  }

  /**
   * Sign-in failed. Wrong password, unknown address and malformed input all produce exactly this —
   * same status, same code, same message — so the response never discloses whether an address has
   * an account.
   */
  static invalidCredentials(): ApiError {
    // One line, says what to do next, and accuses nobody of anything. It is also the *only* thing
    // sign-in ever says on failure, so it must fit a typo and a probe equally well.
    return new ApiError(
      'invalid_credentials',
      401,
      'That email and password do not match. Check them and try again.',
    );
  }

  /**
   * The request could not be read as what the route accepts — a missing field, a body that is not
   * an object, a role nobody offers. `400`, because the caller can fix it and try again.
   */
  static invalidInput(message: string): ApiError {
    return new ApiError('invalid_input', 400, message);
  }

  /**
   * The password was read fine and refused on its merits. Separate from {@link invalidInput}
   * because the accept screen prints this one beside the field rather than as a general failure —
   * and `message` is written to be shown to the person choosing, so it never quotes what they
   * typed.
   */
  static weakPassword(message: string): ApiError {
    return new ApiError('weak_password', 400, message);
  }

  /**
   * That address already has an account. `409` — a conflict with the state of the world, not a
   * malformed request. Only ever returned to an admin issuing an invitation, or to somebody
   * already holding a token for that address; sign-in still discloses nothing.
   */
  static emailTaken(message: string): ApiError {
    return new ApiError('email_taken', 409, message);
  }

  /** That address already has a live invitation. The admin wants resend, not a second token. */
  static invitationExists(message: string): ApiError {
    return new ApiError('invitation_exists', 409, message);
  }

  /**
   * Unknown, malformed, revoked or already accepted — **one code for all four**, so an anonymous
   * guesser cannot learn which of their guesses was ever a real token.
   */
  static invitationInvalid(
    message = 'That invitation link is not valid. Ask an admin to send a new one.',
  ): ApiError {
    return new ApiError('invitation_invalid', 410, message);
  }

  /**
   * Ours, and out of time. Deliberately distinguishable from {@link invitationInvalid}: it is the
   * difference between a screen that says "this expired, ask for another" and one that says
   * "wrong", and only somebody who was genuinely sent this token can reach it.
   */
  static invitationExpired(
    message = 'That invitation expired. Ask an admin to send you a new one.',
  ): ApiError {
    return new ApiError('invitation_expired', 410, message);
  }

/**
   * Unknown, malformed, revoked or already used — **one code for all four**, so an anonymous
   * guesser cannot learn which of their guesses was ever a real reset token. The same split, and
   * the same reasoning, as the two invitation codes.
   */
  static resetInvalid(
    message = 'That reset link is not valid. Ask for a new one and try again.',
  ): ApiError {
    return new ApiError('reset_invalid', 410, message);
  }

  /**
   * Ours, and out of time. Distinguishable from {@link resetInvalid} on purpose: it is the
   * difference between a screen that offers to send another link and one that says "wrong".
   */
  static resetExpired(
    message = 'That reset link has expired. Reset links last one hour — ask for a new one.',
  ): ApiError {
    return new ApiError('reset_expired', 410, message);
  }

  /**
   * The password was right and the account is no longer active.
   *
   * Returned **only after the password verifies**, which is what stops it being an enumeration
   * oracle: a caller who knows the password already knows the account exists. The alternative — one
   * uniform refusal — is marginally safer and lies to a real person who is about to spend twenty
   * minutes hunting for a typo that does not exist, and then email an admin anyway.
   */
  static accountDeactivated(
    message = 'This account is no longer active. Ask an admin to restore it.',
  ): ApiError {
    return new ApiError('account_deactivated', 403, message);
  }

  /**
   * The account is already in the state the request asks for. `409` — a conflict with the state of
   * the world, and a refusal rather than a silent success, so an admin console cannot report an
   * action it did not take.
   */
  static accountStateConflict(message: string): ApiError {
    return new ApiError('account_state_conflict', 409, message);
  }

  /**
   * Refused because it would leave the product with no active admin (docs/project/prd.md, 3.1.11).
   *
   * Its own code rather than `forbidden`, because the caller *was* permitted: what refused is an
   * invariant, not a permission. The message says which invariant, so an operator reads a guardrail
   * rather than a bug and knows the fix is to promote somebody first.
   */
  static lastAdmin(
    message = 'This is the only active admin. Promote another account to admin first, then try again.',
  ): ApiError {
    return new ApiError('last_admin', 409, message);
  }

  /**
   * The key being finalised does not describe an upload we can turn into a recording — nothing is
   * behind it, the store's own metadata fails the re-check, or it already became one.
   *
   * `409` for all three: the request was well-formed and it is the state of the store that refuses
   * it. **The object is left where it is** — nothing in this product deletes from the bucket
   * (docs/project/prd.md, 3.4.9) — so a refusal costs an orphan and never a lost original.
   */
  static uploadInvalid(message: string): ApiError {
    return new ApiError('upload_invalid', 409, message);
  }

  static notFound(message = 'The requested resource does not exist.'): ApiError {
    return new ApiError('not_found', 404, message);
  }

  static serviceUnavailable(message = 'A dependency is unavailable.'): ApiError {
    return new ApiError('service_unavailable', 503, message);
  }
}
