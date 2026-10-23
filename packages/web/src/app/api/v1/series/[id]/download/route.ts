import type { SeriesDownloadPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { describeSeriesDownload } from '@/server/offline/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/series/:id/download` — **what "Download all" would fetch, and what each part
 * costs** ([3.18.6](docs/project/prd.md), [3.18.17](docs/project/prd.md); project tdd 5.8).
 *
 * Behind `series.browse`, and it answers the published recordings only, in the series' own order.
 * No URLs: the queue mints a grant per recording when that recording's turn comes, so a long
 * series never holds a page of signatures that all expire together while the first is still
 * downloading. The check against what the device has free happens on the client, before the
 * queue is built — which is why this route exists at all.
 */
export const GET = apiRoute(permits('series.browse'), async (_request, context) => {
  const payload: SeriesDownloadPayload = await describeSeriesDownload(
    context.actor,
    await routeParam(context.params, 'id'),
  );
  return payload;
});
