import type { InvitationListPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { issueInvitation, listAllInvitations } from '@/server/invitations/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/invitations` — the collection.
 *
 * Admin-only through the policy module, which is what makes "a member cannot invite" a refusal the
 * API issues rather than a control the interface happens not to render. There is no interface for
 * either method yet; docs/epics/epic-core-listening/implementation-plan.md § Ticket 5 builds it over exactly these two.
 */

/** Issue. `201` — the invitation is a resource, and this is the request that created it. */
export const POST = apiRoute(permits('invitation.issue'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const { invitation } = await issueInvitation(context.actor, body);
  return new ApiSuccess(invitation, 201);
});

/**
 * Every invitation with its derived status and expiry. **No token and no hash**, which is a
 * property of the payload type rather than of this handler remembering to strip one.
 */
export const GET = apiRoute(permits('invitation.list'), async (_request, context) => {
  const payload: InvitationListPayload = { invitations: await listAllInvitations(context.actor) };
  return payload;
});
