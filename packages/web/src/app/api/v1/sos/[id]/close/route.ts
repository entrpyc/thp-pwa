import { SESSION } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { closeSignalFor } from '@/server/sos/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/sos/:id/close` — **the author ends their signal, or an admin ends anybody's**
 * ([3.16.8](docs/project/prd.md), [3.16.9](docs/project/prd.md)).
 *
 * One route and two policy answers asked in order — the owned `sos.close`, and `sos.moderate`
 * only where it denied — so an admin closing their *own* signal is not logged as moderation. The
 * optional body carries the author's closing note.
 */
export const POST = apiRoute(SESSION, async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return closeSignalFor(context.actor, await routeParam(context.params, 'id'), body);
});
