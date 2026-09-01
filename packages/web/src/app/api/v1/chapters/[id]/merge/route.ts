import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { mergeChapter } from '@/server/chapters/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/chapters/:id/merge` — **join this chapter to the one before it**
 * ([3.22.7](docs/project/prd.md)).
 *
 * **No body, and backwards always.** A boundary is one thing shared by the pair either side of it,
 * and the boundary a chapter owns is its own start — so naming the chapter names the boundary, and
 * removing it is the whole of the merge. There is nothing left to say in a body, and a body naming
 * "the other one" would be a second way to name a pair this route can already identify.
 *
 * The first chapter has no boundary of its own to remove and is refused.
 *
 * Answers with the whole list, as every chapter write does — which here is how the caller learns
 * that a two-chapter teaching merged into one has none at all
 * ([3.22.4](docs/project/prd.md)).
 */
export const POST = apiRoute(permits('chapter.edit'), async (_request, context) => {
  return mergeChapter(context.actor, await routeParam(context.params, 'id'));
});
