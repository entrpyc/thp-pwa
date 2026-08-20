import { CORRELATION_ID_HEADER } from '@thp/shared';
import { resolveCorrelationId, withCorrelationId } from '@/server/observability/correlation';
import { logger } from '@/server/observability/logger';
import { errorResponse, successResponse } from './envelope';
import { ApiError } from './errors';

export interface ApiHandlerContext {
  readonly correlationId: string;
  readonly params: Promise<Record<string, string | string[] | undefined>>;
}

export type ApiHandler = (request: Request, context: ApiHandlerContext) => Promise<unknown> | unknown;

interface NextRouteContext {
  readonly params?: Promise<Record<string, string | string[] | undefined>>;
}

/** What a handler returns when it needs a status other than `200`. */
export class ApiSuccess {
  constructor(
    readonly payload: unknown,
    readonly status: number,
  ) {}
}

const GENERIC_INTERNAL_MESSAGE =
  'The server failed to handle this request. Quote the correlation id when reporting it.';

/**
 * The single entry point every `/api/v1` route goes through. It owns three things no route is
 * allowed to own itself: the correlation id, the response envelope, and what a thrown error is
 * permitted to tell the client.
 */
export function apiRoute(handler: ApiHandler) {
  return async function handle(request: Request, context: NextRouteContext = {}): Promise<Response> {
    const correlationId = resolveCorrelationId(request.headers.get(CORRELATION_ID_HEADER));

    return withCorrelationId(correlationId, async () => {
      const startedAt = performance.now();
      const url = new URL(request.url);
      logger.info('request.start', { method: request.method, path: url.pathname });

      try {
        const result = await handler(request, {
          correlationId,
          params: context.params ?? Promise.resolve({}),
        });
        const response =
          result instanceof ApiSuccess
            ? successResponse(result.payload, correlationId, result.status)
            : successResponse(result, correlationId);
        logger.info('request.end', {
          method: request.method,
          path: url.pathname,
          status: response.status,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return response;
      } catch (caught) {
        if (caught instanceof ApiError) {
          logger.warn('request.failed', {
            method: request.method,
            path: url.pathname,
            status: caught.status,
            code: caught.code,
            reason: caught.message,
          });
          return errorResponse(caught.code, caught.message, caught.status, correlationId);
        }

        // Unhandled: the detail is logged server-side and never put on the wire.
        logger.error('request.unhandled', {
          method: request.method,
          path: url.pathname,
          status: 500,
          errorName: caught instanceof Error ? caught.name : typeof caught,
          errorMessage: caught instanceof Error ? caught.message : String(caught),
          stack: caught instanceof Error ? caught.stack : undefined,
        });
        return errorResponse('internal_error', GENERIC_INTERNAL_MESSAGE, 500, correlationId);
      }
    });
  };
}
