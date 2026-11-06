import type { NoteFoldersPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { createNoteFolderFor, listNoteFoldersFor } from '@/server/notes/folders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/users/me/note-folders` — **the member's folders**, by name, each with the notes
 * filed in it.
 *
 * `me` rather than an id in the path, exactly as Highlights: the only folders anybody may read
 * are their own, and a path that could name somebody else's would need an ownership rule to
 * refuse what it should never have been able to express. No admin route lists anybody's.
 */
export const GET = apiRoute(permits('note-folder.list'), async (_request, context) => {
  const payload: NoteFoldersPayload = await listNoteFoldersFor(context.actor);
  return payload;
});

/**
 * `POST /api/v1/users/me/note-folders` — **create a folder**. The body carries the name; the
 * answer is the list as it now stands. A taken name is `note_folder_exists`, the hundredth-and-first
 * folder is `note_folders_full`.
 */
export const POST = apiRoute(permits('note-folder.create'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: NoteFoldersPayload = await createNoteFolderFor(context.actor, body);
  return payload;
});
