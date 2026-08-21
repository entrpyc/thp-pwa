import { ApiSuccess, apiRoute } from '@/server/api/route';
import { permits } from '@/server/api/access';
import { resendInvitationById } from '@/server/invitations/service';
import { routeParam } from '@/server/api/params';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/invitations/:id/resend`.
 *
 * Answers `201` with the **new** invitation, not the old one: a resend revokes the previous token
 * and issues a fresh one on a fresh window, so the thing that now exists has a different id and a
 * later expiry. Returning the old row would be describing something that no longer works.
 */
export const POST = apiRoute(permits('invitation.resend'), async (_request, context) => {
  const invitation = await resendInvitationById(context.actor, await routeParam(context.params, 'id'));
  return new ApiSuccess(invitation, 201);
});
