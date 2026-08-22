import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { regenerateSummary } from '@/server/transcripts/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/recordings/:id/summary/regenerate` — a fresh summary, built on the corrected words
 * (docs/project/prd.md, 3.5.6).
 *
 * A sibling of the two summary-gate routes rather than of `reviews/:id/regenerate`, and the
 * difference is what it does to the live text: that one **discards** an open draft and asks for
 * another, while this one leaves the published summary exactly where it is and adds a draft beside
 * it. A member reading the teaching between the press and the approval sees the old summary, which
 * is the whole point of routing the offer this way.
 *
 * `summary.regenerate` is its own action for the same reason `review.regenerate` is separate from
 * `review.resolve`: it spends money at a provider.
 */
export const POST = apiRoute(permits('summary.regenerate'), async (_request, context) => {
  return regenerateSummary(context.actor, await routeParam(context.params, 'id'));
});
