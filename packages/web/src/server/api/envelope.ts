import { CORRELATION_ID_HEADER, type ApiErrorBody, type ApiErrorCode } from '@thp/shared';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

/**
 * Success: the payload at the top level, plus the correlation id on the response.
 *
 * `extraHeaders` exists for `Set-Cookie` and nothing else so far — a route that needs one returns
 * `ApiSuccess` carrying it, rather than building its own `Response` and stepping outside the
 * envelope.
 */
export function successResponse(
  payload: unknown,
  correlationId: string,
  status = 200,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  return new Response(payload === undefined ? '{}' : JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders, [CORRELATION_ID_HEADER]: correlationId },
  });
}

/**
 * Failure: one envelope, always. No route builds its own error body.
 *
 * `extraHeaders` exists for `Retry-After` and nothing else so far. It is deliberately taken from
 * the {@link ApiError} rather than from the route: a refusal that has to say *when to come back*
 * carries that with it, so the header cannot be forgotten at one of the places the refusal is
 * thrown.
 */
export function errorResponse(
  code: ApiErrorCode,
  message: string,
  status: number,
  correlationId: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  const body: ApiErrorBody = { error: { code, message, correlationId } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders, [CORRELATION_ID_HEADER]: correlationId },
  });
}
