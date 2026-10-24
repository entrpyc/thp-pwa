import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { readMindMapFor } from '@/server/mind-maps/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/recordings/:id/mind-map` — **the approved mind map of a published teaching**
 * ([3.8.3](docs/project/prd.md), [3.8.4](docs/project/prd.md)).
 *
 * `recording.browse`, the same action the recording, its transcript and its scripture are behind,
 * reading the same visibility condition: the map rides the recording's publication, so there is no
 * second action to declare and no second gate to keep in step. An unpublished id and an id that
 * never existed answer the same `not_found`.
 *
 * **Read-only.** What a teaching's map says is decided in Pending Reviews and nowhere else
 * ([3.8.2](docs/project/prd.md)).
 */
export const GET = apiRoute(permits('recording.browse'), async (_request, context) => {
  return readMindMapFor(context.actor, await routeParam(context.params, 'id'));
});
