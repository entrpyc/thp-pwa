import { ApiError } from '@/server/api/errors';
import { logger } from '@/server/observability/logger';
import { can, type Actor, type PolicyAction, type PolicyResource } from './policy';

/**
 * Asking the policy module **inside a handler**, for the case a route's access declaration cannot
 * answer on its own.
 *
 * `apiRoute(permits(action), …)` is still the normal way, and it covers every role-only action.
 * What it cannot cover is an **owned** one: `permits` is evaluated when the module loads, so the
 * resource it carries is a constant, and ownership is a fact about the request. Step 4's
 * `profile.update` is the first action of that kind.
 *
 * So the decision still happens in exactly one place — {@link can} — and the only thing that moves
 * is *when* it is asked. The refusal is logged with the same fields and the same message
 * (`authorisation.refused`) as the wrapper's, so one search on a correlation id returns the same
 * story whichever gate refused.
 */
export function authorise(
  actor: Actor,
  action: PolicyAction,
  target: string,
  resource?: PolicyResource,
): void {
  if (can(actor, action, resource)) return;

  logger.warn('authorisation.refused', {
    actorId: actor.id,
    actorEmail: actor.email,
    action,
    target,
    code: 'forbidden',
  });
  throw ApiError.forbidden();
}
