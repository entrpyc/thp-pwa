import type { FlowSessionPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { markFlowItemFor } from '@/server/flow-tracker/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PUT /api/v1/users/me/flow-sessions/{id}/items/{itemId}/done` — tick a reading-list row off,
 * or un-tick it ([3.14.9](docs/project/prd.md)). The member's own bookkeeping; it changes nothing else.
 */
export const PUT = apiRoute(permits('flow.mark'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: FlowSessionPayload = await markFlowItemFor(
    context.actor,
    await routeParam(context.params, 'id'),
    await routeParam(context.params, 'itemId'),
    body,
  );
  return payload;
});
