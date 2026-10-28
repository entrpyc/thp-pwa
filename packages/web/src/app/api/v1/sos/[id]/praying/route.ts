import { SESSION } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { clearPrayingFor, setPrayingFor } from '@/server/sos/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PUT /api/v1/sos/:id/praying` — **I am praying** ([3.16.5](docs/project/prd.md)).
 *
 * `PUT` because a member is praying for a signal or is not: the request states the whole of that,
 * and sending it twice leaves the same one row — the primary key `(signal_id, user_id)` showing
 * through to the verb, as the reaction route's does. The body, optional, says whether the name is
 * listed: `{ "anonymous": true }` is counted and not named.
 */
export const PUT = apiRoute(SESSION, async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return setPrayingFor(context.actor, await routeParam(context.params, 'id'), body);
});

/** `DELETE /api/v1/sos/:id/praying` — take it back. Clearing when nothing is set succeeds. */
export const DELETE = apiRoute(SESSION, async (_request, context) =>
  clearPrayingFor(context.actor, await routeParam(context.params, 'id')),
);
