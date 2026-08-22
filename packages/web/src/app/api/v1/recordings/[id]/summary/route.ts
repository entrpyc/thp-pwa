import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { editSummary } from '@/server/recordings/publication';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PUT /api/v1/recordings/:id/summary` — change what a published summary says
 * (docs/project/prd.md, 3.6.11).
 *
 * `PUT` rather than `POST`, because unlike every other control in this story it genuinely does
 * replace the content of a resource that already exists. It does **not** create one: a recording
 * with no approved draft answers `not_found`, so there is exactly one way a summary comes into
 * being and it is through the review gate.
 *
 * The gate is untouched by this — editing a live summary leaves it live. Taking it down is the
 * sibling route.
 */
export const PUT = apiRoute(permits('summary.edit'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return editSummary(context.actor, await routeParam(context.params, 'id'), body);
});
