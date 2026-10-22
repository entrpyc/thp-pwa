import { SESSION } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { writeAnalyticsPreference } from '@/server/accounts/analytics-preference';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PUT /api/v1/users/me/analytics` — **whether this account is collected by product analytics**
 * (Apple guideline 5.1.1(ii): an easy way to withdraw consent).
 *
 * `me` rather than an id in the path, and a session rather than a policy action, for the reason
 * the speed and the avatar routes give: the only consent anybody may withdraw is their own, and a
 * path that could name somebody else's would need an ownership rule to refuse what it should never
 * have been able to express. An admin ends accounts and changes roles and does not decide what a
 * member consents to.
 */
export const PUT = apiRoute(SESSION, async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return writeAnalyticsPreference(context.actor, body);
});
