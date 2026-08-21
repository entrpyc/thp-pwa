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

  static notFound(message = 'The requested resource does not exist.'): ApiError {
    return new ApiError('not_found', 404, message);
  }

  static serviceUnavailable(message = 'A dependency is unavailable.'): ApiError {
    return new ApiError('service_unavailable', 503, message);
  }
}
