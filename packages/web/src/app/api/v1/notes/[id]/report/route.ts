import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { reportNote } from '@/server/notes/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/notes/:id/report` — **ask an admin to look at this note** (Apple guideline 1.2,
 * Google Play's user-generated-content policy).
 *
 * On the note rather than on the recording, as every single-note route is, and one route for a
 * note and a reply because a reply is a note with a parent. The body carries a reason from the
 * shared list and an optional sentence. Your own note and a private note are `invalid_input`; a
 * removed note is `note_removed`; a second report of the same note by the same member answers the
 * first report's id and writes nothing. `201`, because a row was created — or `200` when it was not.
 */
export const POST = apiRoute(permits('note.report'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const { payload, created } = await reportNote(
    context.actor,
    await routeParam(context.params, 'id'),
    body,
  );
  return created ? new ApiSuccess(payload, 201) : payload;
});
