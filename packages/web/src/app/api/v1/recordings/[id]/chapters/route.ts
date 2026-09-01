import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { readChaptersFor } from '@/server/chapters/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/recordings/:id/chapters` — **the named spans of a published teaching**
 * ([3.22.10](docs/project/prd.md)).
 *
 * `recording.browse`, the same action the recording itself, its transcript and its scripture are
 * behind, reading the same visibility condition. That is [3.22.6](docs/project/prd.md) written as a
 * route: chapters ride the recording's publication, so there is no second action to declare and no
 * second gate to keep in step. An unpublished id and an id that never existed answer the same
 * `not_found`.
 *
 * **Read-only.** A chapter is written by the pipeline step and edited at `/chapters/{id}`, which is
 * where the action that may do so is declared — a teaching is not where its chapters are changed
 * from, even though it is where they are changed *on*.
 *
 * **An empty list is a real answer**, and the common one: a teaching too short to hold two chapters
 * has none ([3.22.4](docs/project/prd.md)).
 */
export const GET = apiRoute(permits('recording.browse'), async (_request, context) => {
  return readChaptersFor(context.actor, await routeParam(context.params, 'id'));
});
