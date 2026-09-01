import type { RecordingPayload, RecordingSummary, UpdateRecordingPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { editRecording, readRecordingFor, surfaceOf } from '@/server/recordings/service';

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

/**
 * `PATCH /api/v1/recordings/:id` — **correct the title and the date recorded**
 * ([3.2.16](docs/project/prd.md)).
 *
 * **On the recording itself rather than on a sub-resource, and that is the distinction the rest of
 * this directory is built on.** Publish, unpublish, series and the summary each hang off a named
 * sub-resource precisely because what they do is *not* edit a recording — they open a gate, or say
 * where a teaching belongs. This one is the exception that proves it: two columns of the row, so it
 * is a write of the row.
 *
 * `PATCH` rather than `PUT` for the same reason `/series/{id}` takes one: the body is the two
 * fields an admin may correct, not the whole of a recording. Everything the body does not carry —
 * the media key, the publication state, the series, the description, the summary — is not merely
 * left alone, it is never read.
 *
 * `recording.edit`, which is admin-only and is deliberately neither `recording.upload` nor
 * `recording.publish`: a member holds it in no role, so a member's `PATCH` is refused by the policy
 * before this handler runs.
 */
export const PATCH = apiRoute(permits('recording.edit'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const recording: RecordingSummary = await editRecording(
    context.actor,
    await routeParam(context.params, 'id'),
    body,
  );
  const payload: UpdateRecordingPayload = { recording };
  return payload;
});
