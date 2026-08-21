import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { routeParam } from '@/server/api/params';
import { deactivateAccount } from '@/server/accounts/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/users/:id/deactivate`.
 *
 * `POST` to a named sub-resource rather than `DELETE /users/:id`, because **deactivation is not
 * deletion** (docs/prd.md, 3.1.7): the account, its password and everything it authored stay
 * exactly where they are. A `DELETE` would name the wrong thing, and self-service deletion
 * ([3.1.8](../../../../../../../docs/prd.md)) is a different requirement in a later slice.
 *
 * Refused when it would leave no active admin — by the write, not by this route.
 */
export const POST = apiRoute(permits('account.deactivate'), async (_request, context) => {
  return deactivateAccount(context.actor, await routeParam(context.params, 'id'));
});
