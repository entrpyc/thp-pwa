import type { MyNotesPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { readOwnNotesFor } from '@/server/notes/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/users/me/notes` — **every note the member wrote, across every teaching**, each
 * inside the thread it belongs to, newest written first.
 *
 * `me` rather than an id in the path, as the Highlights list and the blocked list: the only set
 * of notes this route can name is the caller's own, so there is no ownership rule to refuse what
 * the path cannot express. No admin route lists anybody's.
 *
 * `note.read` is the action, as on a teaching's notes: the policy module answers *who may read
 * notes at all*, and which rows come back is the query's answer — the same condition the
 * recording page's read states, keyed by the member rather than by the teaching. There is no
 * `?filter=` parameter and there will not be one: Public / Private on the page narrows what is
 * *listed* out of what the member already holds.
 */
export const GET = apiRoute(permits('note.read'), async (_request, context) => {
  const payload: MyNotesPayload = await readOwnNotesFor(context.actor);
  return payload;
});
