import { permits } from '@/server/api/access';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { createReleaseNoteFor, listReleaseNotesFor } from '@/server/release-notes/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/release-notes` — the posts that say what is new.
 *
 * `GET` is every member's: the list, newest first, each with its title and the first of its words.
 * `POST` is the admin's, and answers `201` — a post is a resource and this is the request that
 * created it.
 */
export const GET = apiRoute(permits('release-note.list'), async () => listReleaseNotesFor());

export const POST = apiRoute(permits('release-note.create'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return new ApiSuccess(await createReleaseNoteFor(context.actor, body), 201);
});
