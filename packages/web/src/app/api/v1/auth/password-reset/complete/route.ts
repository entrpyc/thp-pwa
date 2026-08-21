import type { SessionPayload } from '@thp/shared';
import { PUBLIC } from '@/server/api/access';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { sessionCookieHeader } from '@/server/auth/session';
import { completePasswordResetWithPassword } from '@/server/password-reset/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/auth/password-reset/complete` — set the new password.
 *
 * Returns the session cookie in the same response, so there is no sign-in form between having a new
 * password and using it. Every *other* live session for the account is ended by the same
 * transaction that changed the password: a reset is what somebody does when they think their
 * password is known, and leaving those alive would make it cosmetic.
 */
export const POST = apiRoute(PUBLIC, async (request) => {
  const body: unknown = await request.json().catch(() => null);
  const { user, session } = await completePasswordResetWithPassword(body);
  const payload: SessionPayload = { user };
  return new ApiSuccess(payload, 200, {
    'set-cookie': sessionCookieHeader(session.token, session.expiresAt),
  });
});
