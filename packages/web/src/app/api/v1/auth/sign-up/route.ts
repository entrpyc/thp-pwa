import type { SessionPayload } from '@thp/shared';
import { PUBLIC } from '@/server/api/access';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { sessionCookieHeader } from '@/server/auth/session';
import { signUp } from '@/server/auth/sign-up';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/auth/sign-up` — registering an account (docs/project/prd.md, 3.1.15).
 *
 * On the allowlist for the reason sign-in and invitation-accept are: requiring a session in order
 * to create the account that would hold one is circular.
 *
 * It answers `201` with the session cookie already set, so registration lands somebody inside in
 * one motion rather than handing them an account and then a sign-in form — the same shape
 * invitation-accept takes, and the same payload, so the client has one response to understand.
 */
export const POST = apiRoute(PUBLIC, async (request) => {
  const body: unknown = await request.json().catch(() => null);
  const { user, session } = await signUp(body);
  const payload: SessionPayload = { user };
  return new ApiSuccess(payload, 201, {
    'set-cookie': sessionCookieHeader(session.token, session.expiresAt),
  });
});
