import { CORRELATION_ID_HEADER } from '@thp/shared';
import { isAllowlisted } from '@/server/auth/allowlist';
import { can, type Actor } from '@/server/auth/policy';
import { actorForToken, readSessionCookie } from '@/server/auth/session';
import { resolveCorrelationId, withCorrelationId } from '@/server/observability/correlation';
import { logger } from '@/server/observability/logger';
import type { ActorFor, RouteAccess } from './access';
import { errorResponse, successResponse } from './envelope';
import { ApiError } from './errors';

export interface ApiHandlerContext<TActor extends Actor | null = Actor | null> {
  readonly correlationId: string;
  /** The caller, re-read from the database this request. `null` only on an allowlisted route. */
  readonly actor: TActor;
  readonly params: Promise<Record<string, string | string[] | undefined>>;
}

export type ApiHandler<TActor extends Actor | null = Actor | null> = (
  request: Request,
  context: ApiHandlerContext<TActor>,
) => Promise<unknown> | unknown;

export type NextRouteHandler = (request: Request, context?: NextRouteContext) => Promise<Response>;

interface NextRouteContext {
  readonly params?: Promise<Record<string, string | string[] | undefined>>;
}

/** What a handler returns when it needs a status other than `200`. */
export class ApiSuccess {
  constructor(
    readonly payload: unknown,
    readonly status: number,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {}
}

const GENERIC_INTERNAL_MESSAGE =
  'The server failed to handle this request. Quote the correlation id when reporting it.';

/**
 * The single entry point every `/api/v1` route goes through. It owns four things no route is
 * allowed to own itself: the correlation id, the response envelope, what a thrown error is
 * permitted to tell the client, and **whether the caller is allowed in at all**.
 *
 * Access is the first argument and is not optional. That is the whole mechanism behind
 * docs/prd.md 3.1.2 — a route cannot be written without saying who may call it, so "every route
 * requires a session" is a property of the type system rather than of code review.
 */
export function apiRoute<TAccess extends RouteAccess>(
  access: TAccess,
  handler: ApiHandler<ActorFor<TAccess>>,
): NextRouteHandler {
  return async function handle(request: Request, context: NextRouteContext = {}): Promise<Response> {
    const correlationId = resolveCorrelationId(request.headers.get(CORRELATION_ID_HEADER));

    return withCorrelationId(correlationId, async () => {
      const startedAt = performance.now();
      const url = new URL(request.url);
      logger.info('request.start', { method: request.method, path: url.pathname });

      try {
        const actor = await admit(access, request, url);
        const result = await handler(request, {
          correlationId,
          // `admit` returns `null` exactly when `access.kind === 'public'`, which is the same
          // condition `ActorFor` branches on — the one place the two representations are joined.
          actor: actor as ActorFor<TAccess>,
          params: context.params ?? Promise.resolve({}),
        });
        const response =
          result instanceof ApiSuccess
            ? successResponse(result.payload, correlationId, result.status, result.headers)
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

/**
 * Decide whether this request gets in, and return the actor the handler will see.
 *
 * Throws rather than returning a verdict so the refusal travels the same path as every other
 * failure — one envelope, one place the status is chosen.
 */
async function admit(access: RouteAccess, request: Request, url: URL): Promise<Actor | null> {
  if (access.kind === 'public') {
    // The declaration alone is not enough. The allowlist is the list, and this is where it is read.
    if (isAllowlisted(request.method, url.pathname)) return null;
    refuse(ApiError.unauthenticated(), null, `route:${url.pathname}`, 'anonymous-access', request);
  }

  const actor = await actorForToken(readSessionCookie(request));
  if (actor === null) {
    refuse(ApiError.unauthenticated(), null, `route:${url.pathname}`, 'anonymous-access', request);
  }

  if (access.kind === 'policy' && !can(actor, access.action, access.resource)) {
    refuse(ApiError.forbidden(), actor, `route:${url.pathname}`, access.action, request);
  }

  return actor;
}

/**
 * Log the refusal, then throw it. Actor, action, target and timestamp, under the request's
 * correlation id — the logger supplies the last two, so one search on the id returns the whole
 * story of the refused request rather than this line alone.
 */
function refuse(
  error: ApiError,
  actor: Actor | null,
  target: string,
  action: string,
  request: Request,
): never {
  logger.warn('authorisation.refused', {
    actorId: actor?.id ?? null,
    actorEmail: actor?.email ?? null,
    action,
    target,
    method: request.method,
    code: error.code,
  });
  throw error;
}
