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

  static notFound(message = 'The requested resource does not exist.'): ApiError {
    return new ApiError('not_found', 404, message);
  }

  static serviceUnavailable(message = 'A dependency is unavailable.'): ApiError {
    return new ApiError('service_unavailable', 503, message);
  }
}
