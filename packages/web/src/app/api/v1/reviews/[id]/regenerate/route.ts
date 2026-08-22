import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { regenerateReview } from '@/server/reviews/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/reviews/:id/regenerate` — throw this draft away and ask for another, optionally
 * saying what was wrong with it (docs/project/prd.md, 3.6.9).
 *
 * A sub-resource rather than a value of the resolve action, because it is the one control here
 * that **spends money at a provider**: `review.regenerate` is its own policy action for the same
 * reason `pipeline.rerun` is separate from `pipeline.read`.
 *
 * The steering sentence is optional, and it ends up in `job.payload` — the column Story 2 Ticket 02
 * deliberately did not create and this story reversed. The handler behind the job is the same one
 * the chain runs, which is what makes Story 5's regeneration offer a call to something that
 * already exists.
 */
export const POST = apiRoute(permits('review.regenerate'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return regenerateReview(context.actor, await routeParam(context.params, 'id'), body);
});
