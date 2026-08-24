import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { readScriptureFor } from '@/server/scripture/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/recordings/:id/scripture` — **the passages a published teaching was built on**
 * ([3.4.2](docs/active-scope/prd.md)–[3.4.3](docs/active-scope/prd.md)).
 *
 * `recording.browse`, the same action the recording itself and its transcript are behind, reading
 * the same visibility condition. That is [3.2.13](docs/active-scope/prd.md) written as a route:
 * references ride the recording's publication, so there is no second action to declare and no
 * second gate to keep in step. An unpublished id and an id that never existed answer the same
 * `not_found`.
 *
 * **Read-only, like every other scripture route.** What a teaching cites is decided in Pending
 * Reviews and nowhere else.
 */
export const GET = apiRoute(permits('recording.browse'), async (_request, context) => {
  return readScriptureFor(context.actor, await routeParam(context.params, 'id'));
});
