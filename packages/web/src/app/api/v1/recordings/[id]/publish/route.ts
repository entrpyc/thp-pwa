import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { publishRecording } from '@/server/recordings/publication';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/recordings/:id/publish` — **the request that makes a teaching visible**
 * (docs/project/prd.md, 3.2.2, 4.17.3).
 *
 * Nothing publishes automatically and nothing precedes this: open drafts, a discarded summary and
 * a missing transcript all leave a recording publishable (docs/project/prd.md, 3.6.10). Pressing
 * twice answers with the timestamp it already had rather than moving it.
 */
export const POST = apiRoute(permits('recording.publish'), async (_request, context) =>
  publishRecording(context.actor, await routeParam(context.params, 'id')),
);
