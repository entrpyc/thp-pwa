import { SESSION } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { replyFor } from '@/server/sos/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/sos/:id/replies` — **a word of encouragement or scripture** ([3.16.6](docs/project/prd.md)).
 * `201`, and the whole signal as it now reads, so the screen replaces what it holds rather than
 * splicing one reply in.
 */
export const POST = apiRoute(SESSION, async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return new ApiSuccess(
    await replyFor(context.actor, await routeParam(context.params, 'id'), body),
    201,
  );
});
