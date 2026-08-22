import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { unpublishRecording } from '@/server/recordings/publication';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/recordings/:id/unpublish` — take it back down without losing anything
 * (docs/project/prd.md, 3.2.11).
 *
 * One write of `null`. The summary, the transcript, the segments, the jobs and the review items all
 * survive, which is what makes re-publishing a restoration rather than a rebuild.
 */
export const POST = apiRoute(permits('recording.unpublish'), async (_request, context) =>
  unpublishRecording(context.actor, await routeParam(context.params, 'id')),
);
