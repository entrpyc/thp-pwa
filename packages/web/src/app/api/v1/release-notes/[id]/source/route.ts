import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { readReleaseNoteSourceFor } from '@/server/release-notes/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/release-notes/{id}/source` — the post as the editor opens it. Behind
 * `release-note.edit`, because it is the one read that carries each picture's upload key: the
 * editor has to send the keys back, and a member's read never holds one.
 */
export const GET = apiRoute(permits('release-note.edit'), async (_request, context) =>
  readReleaseNoteSourceFor(context.actor, await routeParam(context.params, 'id')),
);
