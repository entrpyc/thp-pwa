import type { HighlightListPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { removeHighlightFor } from '@/server/highlights/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `DELETE /api/v1/users/me/highlights/:id` — **remove an entry** ([3.15.8](docs/project/prd.md)).
 *
 * The delete is scoped to the caller's own rows, so an id on somebody else's list removes nothing
 * and answers exactly what an id on nobody's does: success, and the caller's list as it stands.
 * That is the refusal 3.15.9 asks for, done without a verdict that could confirm the id is real.
 */
export const DELETE = apiRoute(permits('highlight.remove'), async (_request, context) => {
  const payload: HighlightListPayload = await removeHighlightFor(
    context.actor,
    await routeParam(context.params, 'id'),
  );
  return payload;
});
