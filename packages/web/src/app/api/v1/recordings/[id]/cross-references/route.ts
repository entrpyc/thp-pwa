import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { readCrossReferencesFor } from '@/server/cross-references/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/recordings/:id/cross-references` — **the moments in other teachings related to
 * this one**, grouped by the sentence of this teaching that triggered them
 * ([3.9.2](docs/project/prd.md), [3.9.5](docs/project/prd.md)).
 *
 * `recording.browse`, the same action the recording itself, its transcript and its scripture are
 * behind, reading the same visibility condition: links ride the recording's publication on both
 * ends, so there is no second action to declare. An unpublished id and an id that never existed
 * answer the same `not_found`.
 *
 * **Read-only.** Links are computed by the worker's `cross_reference` step and by nothing a
 * member or an admin does on this surface.
 */
export const GET = apiRoute(permits('recording.browse'), async (_request, context) => {
  return readCrossReferencesFor(context.actor, await routeParam(context.params, 'id'));
});
