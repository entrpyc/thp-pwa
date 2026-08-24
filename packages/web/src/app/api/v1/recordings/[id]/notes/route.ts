import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { createNote, readNotesFor } from '@/server/notes/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/recordings/:id/notes` — **everything on this teaching this member may see**
 * (active-scope prd 3.2.1).
 *
 * One `GET` and one payload, in the order it reads in. There is no `?filter=` parameter and there
 * will not be one: the All / Public / Mine control (3.2.3) narrows what is *listed* out of what the
 * member was already entitled to, and a filter on the wire would make the interface look like the
 * thing deciding what is reachable. What a member may see is the query's answer.
 *
 * An unpublished id answers `not_found` rather than an empty list (3.2.12) — an empty list is a
 * teaching nobody has annotated, which is a different fact.
 */
export const GET = apiRoute(permits('note.read'), async (_request, context) => {
  return readNotesFor(context.actor, await routeParam(context.params, 'id'));
});

/**
 * `POST /api/v1/recordings/:id/notes` — **write a note at a moment** (active-scope prd 3.1.1).
 *
 * The recording in the path is authoritative and the moment comes from the body, because the
 * position a note is anchored to is the one the player held when the composer opened rather than
 * the one it holds now (3.1.1). Both roles write on the same terms (3.1.12).
 */
export const POST = apiRoute(permits('note.write'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return createNote(context.actor, await routeParam(context.params, 'id'), body);
});
