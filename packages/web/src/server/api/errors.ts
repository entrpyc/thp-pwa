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

  static notFound(message = 'The requested resource does not exist.'): ApiError {
    return new ApiError('not_found', 404, message);
  }

  static serviceUnavailable(message = 'A dependency is unavailable.'): ApiError {
    return new ApiError('service_unavailable', 503, message);
  }
}
