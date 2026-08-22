import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { readTranscriptFor } from '@/server/transcripts/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/recordings/:id/transcript` — **the whole transcript of a published teaching**
 * (docs/project/prd.md, 3.5.3).
 *
 * `recording.browse`, the same action the recording itself is behind, reading the same visibility
 * condition. An unpublished id and an id that never existed answer the same `not_found`.
 *
 * There is deliberately **no `?surface=` parameter**: the transcript has one shape, a member's, and
 * this epic never renders it for an unpublished recording. Correction happens on this same shape,
 * on the same page, after publication.
 */
export const GET = apiRoute(permits('recording.browse'), async (_request, context) => {
  return readTranscriptFor(context.actor, await routeParam(context.params, 'id'));
});
