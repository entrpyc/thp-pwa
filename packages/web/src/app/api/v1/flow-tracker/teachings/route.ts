import type { FlowTeachingsPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { listFlowTeachingsFor } from '@/server/flow-tracker/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/flow-tracker/teachings` — **every published teaching, newest first, with how many
 * questions each would contribute** ([3.14.2](docs/project/prd.md)). What the start screen lists
 * for the member to pick their teachings from.
 */
export const GET = apiRoute(permits('flow.read'), async (_request, context) => {
  const payload: FlowTeachingsPayload = await listFlowTeachingsFor(context.actor);
  return payload;
});
