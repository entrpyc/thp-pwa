import type { SpendPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { raiseSpendCeiling } from '@/server/pipeline/spend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PUT /api/v1/pipeline/spend-ceiling` — raise today's ceiling on provider spend
 * (docs/project/prd.md, 3.19.16).
 *
 * `PUT` because the body is the whole ceiling for the rest of the day — the same request twice
 * leaves the same ceiling — and a sub-resource of the pipeline because that is the one screen it
 * belongs to: the number is shown where the failure it fixes is shown. It answers the same `spend`
 * shape the pipeline list carries, so the panel has one thing to render either way.
 *
 * `spend.raise` rather than `pipeline.rerun`: pressing "run again" spends up to the ceiling, and
 * this moves it. There is no `GET`; the list already carries the number.
 */
export const PUT = apiRoute(permits('spend.raise'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: SpendPayload = await raiseSpendCeiling(context.actor, body);
  return payload;
});
