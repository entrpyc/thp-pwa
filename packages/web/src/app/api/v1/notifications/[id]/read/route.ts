import { SESSION } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { markReadFor } from '@/server/notifications/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PUT /api/v1/notifications/{id}/read` — **this one is read** ([3.17.3](docs/project/prd.md)).
 *
 * Always the caller's own: the store's `where` carries the session's account beside the id, so
 * another member's notification answers `not_found` exactly as an id nobody has does. `PUT`, for
 * the reason the onboarding completion is: a read is a fact that is either recorded or not, and
 * marking it twice is the same fact.
 */
export const PUT = apiRoute(SESSION, async (_request, context) =>
  markReadFor(context.actor, await routeParam(context.params, 'id')),
);
