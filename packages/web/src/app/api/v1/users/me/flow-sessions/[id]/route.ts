import type { FlowSessionPayload, FlowSessionsPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { deleteFlowSessionFor, readFlowSessionFor } from '@/server/flow-tracker/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/users/me/flow-sessions/{id}` — one session of the caller's own, in full: every
 * question in the order asked, and the reading list once it is complete
 * ([3.14.5](docs/project/prd.md), [3.14.9](docs/project/prd.md)).
 */
export const GET = apiRoute(permits('flow.read'), async (_request, context) => {
  const payload: FlowSessionPayload = await readFlowSessionFor(
    context.actor,
    await routeParam(context.params, 'id'),
  );
  return payload;
});

/**
 * `DELETE /api/v1/users/me/flow-sessions/{id}` — a past session of the caller's own goes, with
 * its answers ([3.14.10](docs/project/prd.md)). The one in progress is refused (`invalid_input`):
 * abandoning is its own route. The answer is the caller's sessions as they now stand.
 */
export const DELETE = apiRoute(permits('flow.delete'), async (_request, context) => {
  const payload: FlowSessionsPayload = await deleteFlowSessionFor(
    context.actor,
    await routeParam(context.params, 'id'),
  );
  return payload;
});
