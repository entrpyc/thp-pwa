import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { assignRecordingSeries } from '@/server/series/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PUT /api/v1/recordings/{id}/series` — put this recording into a series, move it, or take it out
 * (Story 6, [3.3.2](docs/project/prd.md), [3.3.9](docs/project/prd.md)).
 *
 * **A sub-resource of the recording, because what it changes is the recording** — the same shape
 * publish and unpublish already take. Create, rename and read hang off `/api/v1/series`; this does
 * not, and that is the difference between "edit the series" and "say where this teaching belongs".
 *
 * `PUT` rather than `POST`: the body states the whole of the recording's series membership, and
 * sending the same body twice leaves the same state.
 */
export const PUT = apiRoute(permits('series.assign'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return assignRecordingSeries(context.actor, await routeParam(context.params, 'id'), body);
});
