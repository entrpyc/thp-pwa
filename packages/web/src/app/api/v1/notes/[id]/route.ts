import { SESSION } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { deleteNote, editNote } from '@/server/notes/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PATCH /api/v1/notes/:id` — **correct your own words** (active-scope prd 3.5.1).
 *
 * `SESSION` rather than `permits(...)` for the reason `users/[id]/route.ts` already reads this way:
 * `permits` is evaluated when the module loads, so the resource it carries is a constant, and
 * `note.edit` is an **owned** action — permitted on what you wrote and on nobody else's, which is a
 * fact about the request rather than about the route. The service asks the policy module the owned
 * question with the note in hand. The decision still happens in exactly one place; only the moment
 * it is asked has moved.
 *
 * Text only (3.5.3). A body carrying a timestamp or a visibility changes neither, in either
 * direction: raising a private note would publish text written in confidence, and lowering a public
 * one would strand the replies other members wrote under it.
 */
export const PATCH = apiRoute(SESSION, async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return editNote(context.actor, await routeParam(context.params, 'id'), body);
});

/**
 * `DELETE /api/v1/notes/:id` — **an author takes their own down, or an admin moderates**
 * (active-scope prd 3.5.2, 3.6.1).
 *
 * One route and two policy answers asked in order: the owned `note.delete`, and `note.moderate`
 * only where it denied. That ordering is not an implementation detail — it is 3.6.4's audit
 * condition, because an admin deleting their *own* note satisfies the first question and is
 * therefore not logged as moderation.
 */
export const DELETE = apiRoute(SESSION, async (_request, context) => {
  return deleteNote(context.actor, await routeParam(context.params, 'id'));
});
