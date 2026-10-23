import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { mintDownloadGrant } from '@/server/offline/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/recordings/:id/download` — **the signed `GET` a download is fetched through, with
 * the object's size** ([3.18.5](docs/project/prd.md), [3.18.17](docs/project/prd.md)).
 *
 * Behind `recording.browse`, published only, the same hour the playback grant gets — a download
 * is the same bytes the player streams, fetched once in full rather than in ranges. The size is
 * what makes this a second route rather than a second caller of the playback one: the client has
 * to know what a download would cost before it starts it, and the player must never pay the
 * `HEAD` that answers that.
 */
export const GET = apiRoute(permits('recording.browse'), async (_request, context) =>
  mintDownloadGrant(context.actor, await routeParam(context.params, 'id')),
);
