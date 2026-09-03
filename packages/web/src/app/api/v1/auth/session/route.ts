import type { SessionPayload, SignOutPayload } from '@thp/shared';
import { PUBLIC, SESSION, permits } from '@/server/api/access';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { describeSessionUser } from '@/server/accounts/session-user';
import {
  clearedSessionCookieHeader,
  readSessionCookie,
  revokeSession,
  sessionCookieHeader,
} from '@/server/auth/session';
import { signIn } from '@/server/auth/sign-in';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/auth/session` — sign-in, sign-out and "who am I" are **one resource, three methods**.
 *
 * `POST` is the only one on the unauthenticated allowlist; requiring a session in order to create
 * one would be circular. `GET` is how the client learns what to render without holding a decision:
 * it returns the account, and the API still refuses independently whatever the client chooses to
 * show.
 */

/** Sign in. Answers `201` — a session is a resource, and this is the request that created it. */
export const POST = apiRoute(PUBLIC, async (request) => {
  const body: unknown = await request.json().catch(() => null);
  const { actor, session } = await signIn(body);
  const payload: SessionPayload = { user: await describeSessionUser(actor) };
  return new ApiSuccess(payload, 201, {
    'set-cookie': sessionCookieHeader(session.token, session.expiresAt),
  });
});

/** The signed-in account. */
export const GET = apiRoute(permits('session.read'), async (_request, context) => {
  const payload: SessionPayload = { user: await describeSessionUser(context.actor) };
  return payload;
});

/**
 * Sign out. The cookie is cleared *and* the record is revoked, so replaying a captured cookie is
 * refused rather than merely inconvenient — which is the whole reason sessions are server-side.
 */
export const DELETE = apiRoute(SESSION, async (request) => {
  await revokeSession(readSessionCookie(request));
  const payload: SignOutPayload = { signedOut: true };
  return new ApiSuccess(payload, 200, { 'set-cookie': clearedSessionCookieHeader() });
});
