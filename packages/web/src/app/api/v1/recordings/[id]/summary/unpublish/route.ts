import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { unpublishSummary } from '@/server/recordings/publication';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/recordings/:id/summary/unpublish` — return a published summary to draft
 * (docs/project/prd.md, 3.6.12).
 *
 * One write of `null` on the summary's own gate, which is why that column is a nullable timestamp
 * rather than a status. The content is retained and the teaching stays live; what changes is that
 * the member read no longer carries the summary.
 */
export const POST = apiRoute(permits('summary.unpublish'), async (_request, context) =>
  unpublishSummary(context.actor, await routeParam(context.params, 'id')),
);
