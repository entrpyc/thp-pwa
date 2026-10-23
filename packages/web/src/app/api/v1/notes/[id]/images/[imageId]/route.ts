import { SESSION } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { removeNoteImage } from '@/server/notes/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `DELETE /api/v1/notes/:id/images/:imageId` — **take one picture off a note**
 * ([3.12.24](docs/project/prd.md)): the author's own, or any on a public note by an admin. `SESSION`
 * and the two policy answers asked in order inside the service, as every owned-or-moderated note
 * route is.
 */
export const DELETE = apiRoute(SESSION, async (_request, context) =>
  removeNoteImage(
    context.actor,
    await routeParam(context.params, 'id'),
    await routeParam(context.params, 'imageId'),
  ),
);
