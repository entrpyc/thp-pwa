import type { SeriesPayload, SeriesView } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { surfaceOf } from '@/server/recordings/service';
import { readSeriesFor, renameSeries } from '@/server/series/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/series/{id}` — one series (Story 6).
 *
 * `GET` answers the series and the recordings in it, newest recorded first, each carrying the
 * requesting member's own position and nobody else's. **A series holding nothing this caller may
 * see answers exactly as one that never existed**, so the API does not report which ids exist.
 *
 * `PATCH` renames it and rewrites its description — a write of the `series` row and nothing
 * beside it, which is what keeps the recordings in a renamed series byte-identical afterwards.
 */

export const GET = apiRoute(permits('series.browse'), async (request, context) => {
  const payload: SeriesPayload = await readSeriesFor(
    context.actor,
    await routeParam(context.params, 'id'),
    surfaceOf(request),
  );
  return payload;
});

export const PATCH = apiRoute(permits('series.update'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const series: SeriesView = await renameSeries(
    context.actor,
    await routeParam(context.params, 'id'),
    body,
  );
  return { series };
});
