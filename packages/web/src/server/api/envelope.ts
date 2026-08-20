import { CORRELATION_ID_HEADER, type ApiErrorBody, type ApiErrorCode } from '@thp/shared';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

/** Success: the payload at the top level, plus the correlation id on the response. */
export function successResponse(payload: unknown, correlationId: string, status = 200): Response {
  return new Response(payload === undefined ? '{}' : JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, [CORRELATION_ID_HEADER]: correlationId },
  });
}

/** Failure: one envelope, always. No route builds its own error body. */
export function errorResponse(
  code: ApiErrorCode,
  message: string,
  status: number,
  correlationId: string,
): Response {
  const body: ApiErrorBody = { error: { code, message, correlationId } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, [CORRELATION_ID_HEADER]: correlationId },
  });
}
