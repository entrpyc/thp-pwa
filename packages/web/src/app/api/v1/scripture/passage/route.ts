import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { readPassageFor } from '@/server/scripture/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/scripture/passage` — **the verse text behind one citation**
 * ([3.3.4](docs/active-scope/prd.md)).
 *
 * `review.list`, the same action the Pending Reviews queue is behind, because this is the queue's
 * own read: it exists so an admin working on a draft sees the passage a row names, including one
 * they have just typed.
 *
 * **`GET` only, and it accepts no text.** Verse text is what the source says
 * ([3.3.8](docs/active-scope/prd.md)); the only thing this route takes is a citation, and the only
 * thing it answers with is what the source already said about it.
 */
export const GET = apiRoute(permits('review.list'), async (request, context) => {
  return readPassageFor(context.actor, new URL(request.url).searchParams);
});
