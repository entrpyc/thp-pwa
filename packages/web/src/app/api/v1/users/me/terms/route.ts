import { SESSION } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { acceptTermsFor } from '@/server/accounts/terms-acceptance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PUT /api/v1/users/me/terms` — **the signed-in account accepts the terms in force** (Google
 * Play's user-generated-content policy).
 *
 * `me` rather than an id in the path, and a session rather than a policy action, for the reason
 * the analytics and avatar routes give: the only acceptance anybody may record is their own, and
 * a path that could name somebody else's would need an ownership rule to refuse what it should
 * never have been able to express. The body names the version the member read, and the service
 * refuses any version but the current one.
 */
export const PUT = apiRoute(SESSION, async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return acceptTermsFor(context.actor, body);
});
