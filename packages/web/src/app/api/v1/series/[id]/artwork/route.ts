import type { SeriesView } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { setArtwork } from '@/server/series/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PUT /api/v1/series/{id}/artwork` — the cover that landed becomes the series' cover.
 *
 * `PUT` rather than `POST` because it is idempotent in the way that matters: naming the same key
 * twice leaves the series pointing at the same object. Naming a *different* key replaces the
 * pointer, which is the whole of scope prd 3.1.5 — there is no `DELETE` here, and the store the
 * pointer names has nothing to delete with either.
 *
 * The store is asked what is actually behind the key before anything is written, so a refusal
 * leaves the series with the cover it had rather than half a new one.
 */
export const PUT = apiRoute(permits('series.artwork'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const series: SeriesView = await setArtwork(
    context.actor,
    await routeParam(context.params, 'id'),
    body,
  );
  return { series };
});
