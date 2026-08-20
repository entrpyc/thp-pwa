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
 */
export const API_ERROR_CODES = [
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
