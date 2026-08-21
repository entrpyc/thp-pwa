import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { routeParam } from '@/server/api/params';
import { reactivateAccount } from '@/server/accounts/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/users/:id/reactivate` — the inverse write.
 *
 * Its own route and its own policy action rather than a flag on deactivate, so an operator surface
 * can offer one without offering the other, and so the log says which of the two happened without
 * anybody having to read a body.
 */
export const POST = apiRoute(permits('account.reactivate'), async (_request, context) => {
  return reactivateAccount(context.actor, await routeParam(context.params, 'id'));
});
