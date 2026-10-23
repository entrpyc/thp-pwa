import { SESSION } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { readPushPreferencesFor, writePushPreferenceFor } from '@/server/notifications/push-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/notifications/push-preferences` — **the member's push switches**
 * ([3.17.13](docs/project/prd.md), [3.17.14](docs/project/prd.md)).
 *
 * `GET` answers the categories this account can switch, each with its setting, and the public
 * Web Push key a browser subscribes with. `PUT` sets one category and answers the same list, so
 * the section renders from one shape. Behind a session and nothing more, as the centre's routes
 * are: the only switches anybody may set are their own.
 */
export const GET = apiRoute(SESSION, async (_request, context) => readPushPreferencesFor(context.actor));

export const PUT = apiRoute(SESSION, async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return writePushPreferenceFor(context.actor, body);
});
