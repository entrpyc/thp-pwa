import type { FlowSessionPayload, FlowSessionsPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { listFlowSessionsFor, startFlowSessionFor } from '@/server/flow-tracker/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/users/me/flow-sessions` — **the member's sessions**: the one in progress and the
 * completed ones ([3.14.10](docs/project/prd.md)).
 *
 * `me` rather than an id in the path, exactly as Highlights: the only sessions anybody may read are
 * their own ([3.14.8](docs/project/prd.md)), and a path that could name somebody else's would need
 * an ownership rule to refuse what it should never have been able to express. No admin route lists
 * anybody's.
 */
export const GET = apiRoute(permits('flow.read'), async (_request, context) => {
  const payload: FlowSessionsPayload = await listFlowSessionsFor(context.actor);
  return payload;
});

/**
 * `POST /api/v1/users/me/flow-sessions` — **start a session over the teachings the member
 * picked** ([3.14.2](docs/project/prd.md)). `201` with the session in full. A session already
 * in progress is `flow_session_in_progress`.
 */
export const POST = apiRoute(permits('flow.start'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: FlowSessionPayload = await startFlowSessionFor(context.actor, body);
  return new ApiSuccess(payload, 201);
});
