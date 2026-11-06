import type { NoteFoldersPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { removeNoteFolderFor, renameNoteFolderFor } from '@/server/notes/folders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PATCH /api/v1/users/me/note-folders/:id` — **rename a folder** of the caller's own. The body
 * carries the name; the answer is the list as it now stands. An id that is not the caller's is
 * `not_found`, whether it is somebody else's or nobody's.
 */
export const PATCH = apiRoute(permits('note-folder.rename'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: NoteFoldersPayload = await renameNoteFolderFor(
    context.actor,
    await routeParam(context.params, 'id'),
    body,
  );
  return payload;
});

/**
 * `DELETE /api/v1/users/me/note-folders/:id` — **remove a folder**; the notes in it stay, unfiled.
 *
 * The delete is scoped to the caller's own rows, so an id on somebody else's list removes nothing
 * and answers exactly what an id on nobody's does: success, and the caller's list as it stands.
 */
export const DELETE = apiRoute(permits('note-folder.remove'), async (_request, context) => {
  const payload: NoteFoldersPayload = await removeNoteFolderFor(
    context.actor,
    await routeParam(context.params, 'id'),
  );
  return payload;
});
