import type { NoteFoldersPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { setNoteFoldersFor } from '@/server/notes/folders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PUT /api/v1/notes/:id/folders` — **set which of the caller's folders this note is in**,
 * replacing the set; an empty list unfiles it. Only the author's own standing top-level notes can
 * be filed, and only into folders of the caller's own; every other case is one `not_found`
 * sentence. The answer is the caller's folders as they now stand.
 */
export const PUT = apiRoute(permits('note-folder.file'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: NoteFoldersPayload = await setNoteFoldersFor(
    context.actor,
    await routeParam(context.params, 'id'),
    body,
  );
  return payload;
});
