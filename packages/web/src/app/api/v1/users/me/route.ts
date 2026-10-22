import { findUserById } from '@thp/db';
import type { AccountDeletedPayload } from '@thp/shared';
import { SESSION } from '@/server/api/access';
import { ApiError } from '@/server/api/errors';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { deleteOwnAccount } from '@/server/accounts/deletion';
import { clearedSessionCookieHeader } from '@/server/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `DELETE /api/v1/users/me` — permanently delete your own account
 * ([3.1.8](docs/project/prd.md)), confirmed with the current password in the body.
 *
 * `me` and a `DELETE`, where an admin's deactivation is a `POST` to `/users/:id/deactivate`,
 * because the two are different acts on different resources: deactivation keeps everything and
 * is reversible; this removes the person and is not. A session rather than a policy action, as
 * the avatar and playback-speed routes are: the only account anybody may delete this way is their
 * own, and a path that could name somebody else's would need an ownership rule to refuse what it
 * should never have been able to express.
 *
 * **The cookie is cleared in the same response.** Every session row went with the account, so the
 * cookie is already dead on the server; clearing it as well is what keeps the browser from sending
 * a token that answers `401` to every page until it expires.
 */
export const DELETE = apiRoute(SESSION, async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  // Re-read rather than trusted from the session: the hash the password is checked against must
  // be the one on the row *now*, and the avatar key handed to the store must be too.
  const current = await findUserById(context.actor.id);
  if (current === null) throw ApiError.notFound('There is no such account.');

  const payload: AccountDeletedPayload = await deleteOwnAccount(context.actor, body, current);
  return new ApiSuccess(payload, 200, { 'set-cookie': clearedSessionCookieHeader() });
});
