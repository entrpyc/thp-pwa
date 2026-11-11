import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import {
  deleteReleaseNoteFor,
  editReleaseNoteFor,
  readReleaseNoteFor,
} from '@/server/release-notes/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/release-notes/{id}` — one post.
 *
 * `GET` is every member's and carries the body with each picture signed into a URL. `PATCH`
 * rewrites the title and the body; `DELETE` removes the post and moves the notices that opened it
 * to the list. Both writes are the admin's.
 */
export const GET = apiRoute(permits('release-note.read'), async (_request, context) =>
  readReleaseNoteFor(await routeParam(context.params, 'id')),
);

export const PATCH = apiRoute(permits('release-note.edit'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return editReleaseNoteFor(context.actor, await routeParam(context.params, 'id'), body);
});

export const DELETE = apiRoute(permits('release-note.delete'), async (_request, context) =>
  deleteReleaseNoteFor(context.actor, await routeParam(context.params, 'id')),
);
