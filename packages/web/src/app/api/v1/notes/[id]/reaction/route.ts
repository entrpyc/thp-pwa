import { SESSION } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { clearReaction, setReaction } from '@/server/notes/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PUT /api/v1/notes/:id/reaction` — **set or replace** (active-scope prd 3.4.3).
 *
 * `PUT` rather than `POST` because a member holds at most one reaction per note: the request states
 * the whole of what their reaction is, and sending it twice leaves the same one row. That is the
 * primary key `(note_id, user_id)` showing through to the verb.
 *
 * `SESSION` and then `authorise` inside the handler, like every route whose refusal depends on the
 * resource: `note.react` is role-only, but the *state* rules — a private note takes none, a removed
 * one answers `note_removed` — need the note in hand, and splitting the two gates across two files
 * would put half the refusal here and half in the service.
 */
export const PUT = apiRoute(SESSION, async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return setReaction(context.actor, await routeParam(context.params, 'id'), body);
});

/**
 * `DELETE /api/v1/notes/:id/reaction` — **take it back** (active-scope prd 3.4.4).
 *
 * Clearing when nothing is set succeeds. The member asked for a state and has it.
 */
export const DELETE = apiRoute(SESSION, async (_request, context) => {
  return clearReaction(context.actor, await routeParam(context.params, 'id'));
});
