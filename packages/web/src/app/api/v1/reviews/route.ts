import type { ReviewListPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { readReviewQueue } from '@/server/reviews/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/reviews` — **everything waiting on an admin**
 * (docs/project/prd.md, 3.19.2).
 *
 * One query over one column, of both kinds together, newest recording first. Admin-only through
 * the policy module and refused there rather than by the panel: the page gate decides what to
 * render and authorises nothing.
 *
 * No pagination, no filters and no search. There are five recordings and at most ten open items,
 * and a control nobody needs is a control somebody has to maintain.
 */
export const GET = apiRoute(permits('review.list'), async (_request, context) => {
  const payload: ReviewListPayload = { reviews: await readReviewQueue(context.actor) };
  return payload;
});
