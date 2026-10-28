import type { FlowSessionPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { answerFlowItemFor } from '@/server/flow-tracker/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PUT /api/v1/users/me/flow-sessions/{id}/items/{itemId}` — **answer one question**
 * ([3.14.6](docs/project/prd.md)). The answer is a rating from 1 to 5; answering again replaces
 * it. The answer that completes the session is answered with the reading list.
 */
export const PUT = apiRoute(permits('flow.answer'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: FlowSessionPayload = await answerFlowItemFor(
    context.actor,
    await routeParam(context.params, 'id'),
    await routeParam(context.params, 'itemId'),
    body,
  );
  return payload;
});
