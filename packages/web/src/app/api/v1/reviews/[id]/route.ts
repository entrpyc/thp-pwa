import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { resolveReview } from '@/server/reviews/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/reviews/:id` — accept this draft, accept it with edits, or throw it away
 * (docs/project/prd.md, 3.6.6–3.6.10).
 *
 * **The action is in the body, not in the path**, and the edited text rides with it. Three
 * near-identical routes would be three places the "already closed" refusal has to be remembered,
 * and approving-with-edits is not a different act from approving — it is the same act with
 * different words in it (docs/project/prd.md, 3.6.8).
 *
 * `POST` rather than `PATCH`: what this does is close a proposal, not edit a resource.
 */
export const POST = apiRoute(permits('review.resolve'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return resolveReview(context.actor, await routeParam(context.params, 'id'), body);
});
