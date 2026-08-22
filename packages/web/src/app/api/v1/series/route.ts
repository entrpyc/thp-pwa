import type { SeriesListPayload, SeriesView } from '@thp/shared';
import { permits } from '@/server/api/access';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { surfaceOf } from '@/server/recordings/service';
import { createSeries, listSeriesFor } from '@/server/series/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/series` — the collection (Story 6).
 *
 * **Two actions, one path.** Creating is `series.create` and is admin-only in this epic; reading is
 * `series.browse`, which both roles hold, because the console's list of every series and a member's
 * list of the ones worth opening are two answers about the same rows rather than two resources.
 * What separates them is whether the caller also satisfies `series.list` and which surface they
 * asked for — never a role compared here.
 */

/** Create a series. `201` — a series is a resource, and this is the request that created it. */
export const POST = apiRoute(permits('series.create'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const series: SeriesView = await createSeries(context.actor, body);
  return new ApiSuccess({ series }, 201);
});

/**
 * Every series **this caller may see**, most recently taught first.
 *
 * The console's reading includes a series with nothing in it — that is where an empty series
 * becomes fillable — and counts every recording assigned. A member's excludes it and counts
 * published recordings only. No pagination and no filters: [§3.10](docs/project/prd.md) is
 * deferred, and a control nobody needs is a control somebody has to maintain.
 */
export const GET = apiRoute(permits('series.browse'), async (request, context) => {
  const payload: SeriesListPayload = {
    series: await listSeriesFor(context.actor, surfaceOf(request)),
  };
  return payload;
});
