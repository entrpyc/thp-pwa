import { SESSION, permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { routeParam } from '@/server/api/params';
import { updateAccount } from '@/server/accounts/service';
import { deleteAccountAsAdmin } from '@/server/accounts/deletion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PATCH /api/v1/users/:id` — change a role, or change your own display name.
 *
 * **Why `SESSION` and not `permits(...)`.** Every other route in the product states its policy
 * action in the access declaration, and that is still the rule. This one cannot: `permits` is
 * evaluated when the module loads, so the resource it carries is a constant, and `profile.update`
 * is the product's first **owned** action — permitted on your own account and on nobody else's,
 * which is a fact about the request rather than about the route. So the wrapper checks that there
 * is a session, and the service asks the policy module the owned question with the resource in
 * hand. The decision still happens in exactly one place; only the moment it is asked has moved.
 *
 * The role half is admin-only and guarded: demoting the last active admin is refused by the write
 * itself (docs/project/prd.md, 3.1.11).
 */
export const PATCH = apiRoute(SESSION, async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return updateAccount(context.actor, await routeParam(context.params, 'id'), body);
});

/**
 * `DELETE /api/v1/users/:id` — an admin permanently deletes somebody else's account.
 *
 * The same erasure as `DELETE /users/me` ([3.1.8](docs/project/prd.md)) — placeholder, retained
 * public notes, everything else gone — reached through a policy action rather than a password,
 * because the admin does not have the person's password and the policy module is what says an
 * operator may do this. Deactivation stays a `POST` to its own sub-resource: that one is
 * reversible, and this one is what a `DELETE` on the account itself ought to mean.
 *
 * Refused for your own row (the self-service door confirms that with a password) and for the
 * last active admin — both by the service, not by this route.
 */
export const DELETE = apiRoute(permits('account.delete'), async (_request, context) => {
  return deleteAccountAsAdmin(context.actor, await routeParam(context.params, 'id'));
});
