import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { splitChapter } from '@/server/chapters/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/chapters/:id/split` — **cut a chapter in two**
 * ([3.22.7](docs/project/prd.md)).
 *
 * `POST` to a named sub-resource rather than a `PUT` of the row, for the reason publishing is a
 * sub-resource of a recording: what this does is not edit a chapter, it makes a second one. The
 * body carries where the second chapter begins and what it is called; the one being split keeps its
 * own title, because a split does not rename what was already there.
 *
 * Answers with the whole list, as every chapter write does.
 */
export const POST = apiRoute(permits('chapter.edit'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return splitChapter(context.actor, await routeParam(context.params, 'id'), body);
});
