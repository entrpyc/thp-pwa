import type { RecordingPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { readRecordingFor, surfaceOf } from '@/server/recordings/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/recordings/:id` — **one teaching, as this caller may read it** (Story 4 Ticket 01).
 *
 * `recording.browse`, the same action the list is behind, reading the same visibility condition. A
 * member gets a published recording's title, date, description and — only when both gates are open
 * — its summary. An unpublished id and an id that never existed answer the same `not_found`, so
 * the API does not report which ids exist.
 */
export const GET = apiRoute(permits('recording.browse'), async (request, context) => {
  const payload: RecordingPayload = {
    recording: await readRecordingFor(
      context.actor,
      await routeParam(context.params, 'id'),
      surfaceOf(request),
    ),
  };
  return payload;
});
