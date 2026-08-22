import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { correctTranscriptSegment } from '@/server/transcripts/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PATCH /api/v1/recordings/:id/transcript/segments/:segmentId` — fix what the machine misheard
 * (docs/project/prd.md, 3.5.5).
 *
 * `PATCH` rather than `PUT`: what crosses the wire is the part of the line an admin may change —
 * the words and the two offsets — and not the segment, whose id, parent, speaker index and
 * corrected-by stamp are the table's business. A body carrying `speaker` is refused rather than
 * quietly ignored.
 *
 * `transcript.correct` is admin-only in this epic. The client hides the control; this route is what
 * refuses it (docs/project/prd.md, 3.1.5).
 */
export const PATCH = apiRoute(permits('transcript.correct'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return correctTranscriptSegment(
    context.actor,
    await routeParam(context.params, 'id'),
    await routeParam(context.params, 'segmentId'),
    body,
  );
});
