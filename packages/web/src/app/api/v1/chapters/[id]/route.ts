import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { editChapter } from '@/server/chapters/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PUT /api/v1/chapters/:id` — **retitle a chapter, rewrite its summary, move its boundary**
 * ([3.22.7](docs/project/prd.md)).
 *
 * `PUT` rather than `PATCH`, and all three fields together, for the reason a transcript correction
 * sends all three of its own: an edit states what the chapter now says and where it now starts, and
 * a partial body would make "the admin left the boundary alone" and "the form forgot to send it"
 * the same request.
 *
 * **The chapter is addressed on its own**, not under its recording. A chapter has an id and an
 * admin acts on that chapter; routing it under the teaching would put a recording id in every
 * request that has no use for one, and would invite the two to disagree.
 *
 * **It answers with the whole list.** Moving a boundary changes where the chapter *before* it ends,
 * so a payload carrying the edited row alone would be a payload that is wrong about two chapters
 * (project tdd 3.7).
 */
export const PUT = apiRoute(permits('chapter.edit'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return editChapter(context.actor, await routeParam(context.params, 'id'), body);
});
