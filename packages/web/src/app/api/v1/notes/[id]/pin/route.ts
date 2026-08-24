import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { pinNoteFor, unpinNoteFor } from '@/server/notes/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PUT /api/v1/notes/:id/pin` — **raise a note above the list** (active-scope prd 3.6.5).
 *
 * Addressed on the **note** rather than on the recording: with any number of pins allowed, a
 * recording no longer has *a* pin to `PUT`, and a route that pretended it did would make adding a
 * second pin look like replacing the first.
 *
 * Idempotent (3.6.6) — pinning something already pinned succeeds and changes nothing, so an admin
 * acting on a stale screen has still got what they asked for rather than a refusal for being slow.
 */
export const PUT = apiRoute(permits('note.pin'), async (_request, context) => {
  return pinNoteFor(context.actor, await routeParam(context.params, 'id'));
});

/**
 * `DELETE /api/v1/notes/:id/pin` — **lower one, leaving the rest** (active-scope prd 3.6.7).
 *
 * Its own policy action rather than a second use of `note.pin`, following the
 * `recording.publish` / `unpublish` split: taking something away from what the whole group reads
 * first is a distinct act, and it became load-bearing the moment a recording could hold more than
 * one pin.
 */
export const DELETE = apiRoute(permits('note.unpin'), async (_request, context) => {
  return unpinNoteFor(context.actor, await routeParam(context.params, 'id'));
});
