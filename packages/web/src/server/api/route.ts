import { CORRELATION_ID_HEADER } from '@thp/shared';
import { apiRoutePattern } from '@thp/shared/observability/exceptions';
import { isAllowlisted } from '@/server/auth/allowlist';
import { can, type Actor } from '@/server/auth/policy';
import { actorForToken, readSessionCookie } from '@/server/auth/session';
import { readAppOrigin } from '@/server/mail/env';
import { captureServerException } from '@/server/observability/analytics';
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
 * docs/project/prd.md 3.1.2 — a route cannot be written without saying who may call it, so "every route
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
        requireOwnOrigin(request, url);
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
          return errorResponse(
            caught.code,
            caught.message,
            caught.status,
            correlationId,
            caught.headers,
          );
        }

        // A value Postgres could not read as the column's type — nearly always a path or body id
        // that is not a uuid, which `eq(uuidColumn, id)` hands to the driver as-is — or one it
        // could read but not store, an integer past the column's range. Either is the caller's
        // input being wrong, not the server failing, so it answers as `invalid_input` rather than
        // as a 500 that an error tracker files (security audits 2026-10-28 finding 14, 2026-10-29
        // finding 16).
        if (isInputPostgresRefused(caught)) {
          const refusal = ApiError.invalidInput('A value in this request is not in the shape the route expects.');
          logger.warn('request.failed', {
            method: request.method,
            path: url.pathname,
            status: refusal.status,
            code: refusal.code,
            reason: caught instanceof Error ? caught.message : String(caught),
          });
          return errorResponse(refusal.code, refusal.message, refusal.status, correlationId);
        }

        // Unhandled: the detail is logged server-side and never put on the wire. The same failure
        // is reported to the error tracker under the same correlation id, with the route pattern
        // rather than the path and nothing of the request's body (observability.md § 5.6).
        const reported = captureServerException(caught, {
          correlation_id: correlationId,
          method: request.method,
          route: apiRoutePattern(url.pathname),
          status: 500,
        });
        logger.error('request.unhandled', {
          method: request.method,
          path: url.pathname,
          status: 500,
          errorName: caught instanceof Error ? caught.name : typeof caught,
          errorMessage: caught instanceof Error ? caught.message : String(caught),
          stack: caught instanceof Error ? caught.stack : undefined,
          reported,
        });
        return errorResponse('internal_error', GENERIC_INTERNAL_MESSAGE, 500, correlationId);
      }
    });
  };
}

/** Methods that change nothing. Everything else is held to the origin rule below. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * **A state-changing request must come from this site** (docs/security-audit-2026-10-29.md,
 * finding 3). The session cookie is `SameSite=Lax`, which keeps other *registrable domains* out;
 * it does nothing against a sibling host under the same parent domain, and the box serves other
 * sites. Three checks, each one a browser makes for us and none of which a cross-site page can
 * forge:
 *
 * 1. `Sec-Fetch-Site`, when present, must be `same-origin` or `none` (a bookmark, a typed URL).
 * 2. `Origin`, when present, must be this site's — the configured origin, or the host the request
 *    itself was addressed to, so a developer on `127.0.0.1` against a `localhost` configuration is
 *    not locked out. A sandboxed frame's `null` origin is nobody's.
 * 3. A body must be `application/json`. Every handler reads JSON, and the one body a cross-site
 *    page can send without a preflight is `text/plain` or a form.
 *
 * A request carrying none of the headers — a test runner, `curl` — passes: a cookie-bearing
 * request a browser did not make is not a forgery, and the checks exist to catch a browser that
 * was made to send one.
 */
function requireOwnOrigin(request: Request, url: URL): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;

  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    refuse(ApiError.forbidden(CROSS_SITE_MESSAGE), null, `route:${url.pathname}`, 'cross-site-request', request);
  }

  const origin = request.headers.get('origin');
  if (origin !== null && !isOwnOrigin(origin, url)) {
    refuse(ApiError.forbidden(CROSS_SITE_MESSAGE), null, `route:${url.pathname}`, 'cross-site-request', request);
  }

  // Whether a body was sent is read off the headers: Next hands a handler a `Request` whose body
  // stream exists for every non-GET request, bytes or none, so `request.body !== null` would call a
  // bare `DELETE` a body.
  const length = request.headers.get('content-length');
  const hasBody = (length !== null && length !== '0') || request.headers.get('transfer-encoding') !== null;
  if (hasBody) {
    const type = request.headers.get('content-type') ?? '';
    if (type.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      refuse(
        ApiError.invalidInput('Send the body as application/json.'),
        null,
        `route:${url.pathname}`,
        'body-not-json',
        request,
      );
    }
  }
}

const CROSS_SITE_MESSAGE = 'This request did not come from the app.';

/** Whether an `Origin` header names this site: the configured origin, or the host addressed. */
function isOwnOrigin(origin: string, url: URL): boolean {
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  if (host === '') return false;
  if (host === url.host) return true;
  try {
    return host === new URL(readAppOrigin()).host;
  } catch {
    return false;
  }
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
    action,
    target,
    method: request.method,
    code: error.code,
  });
  throw error;
}

/** The two SQLSTATEs that mean "the value was the caller's problem": bad text, and out of range. */
const INPUT_REFUSED_SQLSTATES = new Set(['22P02', '22003']);

/**
 * Whether a thrown error is Postgres refusing a value as its column's type (SQLSTATE `22P02`,
 * "invalid text representation") or as its column's range (`22003`, "numeric value out of
 * range"). The driver's error is wrapped by Drizzle as a `cause`, so the walk is the same one
 * `isUniqueViolation` in `@thp/db` does for `23505`.
 */
function isInputPostgresRefused(cause: unknown): boolean {
  for (let current: unknown = cause, depth = 0; current != null && depth < 5; depth += 1) {
    if (typeof current !== 'object') break;
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && INPUT_REFUSED_SQLSTATES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
