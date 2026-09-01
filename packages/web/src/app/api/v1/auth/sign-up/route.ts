import type { SessionPayload } from '@thp/shared';
import { PUBLIC } from '@/server/api/access';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { sessionCookieHeader } from '@/server/auth/session';
import { signUp } from '@/server/auth/sign-up';
import { signUpGuard } from '@/server/auth/sign-up-limits';

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
 *
 * **Rate-limited, and this is the only route in the product that is** (docs/project/prd.md, 3.1.18).
 * It is the only unauthenticated route that writes, and the only one that tells an anonymous caller
 * a fact about an account it does not hold — see `sign-up-limits.ts` for the two budgets and the
 * argument for each. The check is the first thing that happens, before the body is even read: work
 * a refused caller can make the server do is work the limit did not prevent.
 */
export const POST = apiRoute(PUBLIC, async (request) => {
  signUpGuard().enforce(request);

  const body: unknown = await request.json().catch(() => null);
  const { user, session } = await signUp(body);
  const payload: SessionPayload = { user };
  return new ApiSuccess(payload, 201, {
    'set-cookie': sessionCookieHeader(session.token, session.expiresAt),
  });
});
