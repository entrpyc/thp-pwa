import type { FlowSessionPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { abandonFlowSessionFor } from '@/server/flow-tracker/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/users/me/flow-sessions/{id}/abandon` — the member gives the session up
 * ([3.14.10](docs/project/prd.md)), which is what starting another one asks for first.
 */
export const POST = apiRoute(permits('flow.abandon'), async (_request, context) => {
  const payload: FlowSessionPayload = await abandonFlowSessionFor(
    context.actor,
    await routeParam(context.params, 'id'),
  );
  return payload;
});
