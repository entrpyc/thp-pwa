import { SESSION } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import {
  registerPushSubscriptionFor,
  unregisterPushSubscriptionFor,
} from '@/server/notifications/push-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/notifications/push-subscriptions` — **this device, for this account**
 * ([3.17.1](docs/project/prd.md), [5.2.5](docs/project/prd.md)).
 *
 * `PUT` registers the device the client just subscribed — a Web Push endpoint with its keys, or a
 * store build's token — and re-points it if it was already known. `DELETE` forgets it; the
 * sign-out button calls it before ending the session, which is why it needs the session to still
 * be there. Both are the caller's own by construction: the account is the session's, and the
 * address is whatever the device itself was handed by its platform.
 */
export const PUT = apiRoute(SESSION, async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return registerPushSubscriptionFor(context.actor, body);
});

export const DELETE = apiRoute(SESSION, async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return unregisterPushSubscriptionFor(context.actor, body);
});
