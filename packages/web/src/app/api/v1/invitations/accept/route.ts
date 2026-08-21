import { INVITATION_TOKEN_PARAM, type InvitationPreviewPayload, type SessionPayload } from '@thp/shared';
import { PUBLIC } from '@/server/api/access';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { sessionCookieHeader } from '@/server/auth/session';
import { acceptInvitationWithPassword, previewInvitation } from '@/server/invitations/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/invitations/accept` — **the two unauthenticated routes step 3 adds**, and the only ones.
 *
 * Both are on `server/auth/allowlist.ts`, which is the single list of exceptions to "every route
 * requires a session"; declaring them `PUBLIC` here would do nothing on its own. Neither carries
 * account content: the preview answers with the address the token was already mailed to and the
 * role it carries, and accept answers with the account it has just created for the person holding
 * that token.
 */

/**
 * Preview. What lets a dead link say "expired" *before* somebody chooses a password, rather than
 * after they have typed one into a form that was always going to fail.
 */
export const GET = apiRoute(PUBLIC, async (request): Promise<InvitationPreviewPayload> => {
  const token = new URL(request.url).searchParams.get(INVITATION_TOKEN_PARAM);
  return previewInvitation(token);
});

/**
 * Accept. Creates the account **and** returns the session cookie in the same response, so there is
 * no sign-in form between choosing a password and being inside.
 */
export const POST = apiRoute(PUBLIC, async (request) => {
  const body: unknown = await request.json().catch(() => null);
  const { user, session } = await acceptInvitationWithPassword(body);
  const payload: SessionPayload = { user };
  return new ApiSuccess(payload, 201, {
    'set-cookie': sessionCookieHeader(session.token, session.expiresAt),
  });
});
