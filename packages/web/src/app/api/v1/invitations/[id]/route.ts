import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { revokeInvitationById } from '@/server/invitations/service';
import { routeParam } from '@/server/api/params';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `DELETE /api/v1/invitations/:id` — revoke.
 *
 * `DELETE` rather than a `POST .../revoke`, because revoking is what removing a *pending*
 * invitation means: the row stays as a record of what happened, and the token stops working. An
 * accepted invitation cannot be revoked at all — it is an account now, and step 4 owns ending one.
 */
export const DELETE = apiRoute(permits('invitation.revoke'), async (_request, context) => {
  return revokeInvitationById(context.actor, await routeParam(context.params, 'id'));
});
