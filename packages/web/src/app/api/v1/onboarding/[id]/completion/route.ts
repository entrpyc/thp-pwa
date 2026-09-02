import { SESSION } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { recordOnboardingCompletion } from '@/server/onboarding/completion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/onboarding/:id/completion` — **this account has been through this onboarding**.
 *
 * Behind a session and nothing more: the row is keyed on the caller's own id, so there is no
 * resource to authorise against — the id in the path names the *onboarding* and the account comes
 * from the session, the same shape playback progress takes.
 *
 * `PUT`, because a completion is a fact that is either recorded or not: the write is idempotent on
 * the pair, and a replay answers with the moment the completion originally happened.
 */
export const PUT = apiRoute(SESSION, async (_request, context) =>
  recordOnboardingCompletion(context.actor, await routeParam(context.params, 'id')),
);
