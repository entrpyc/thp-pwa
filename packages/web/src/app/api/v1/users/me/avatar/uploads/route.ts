import type { UploadGrantPayload } from '@thp/shared';
import { SESSION } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { grantAvatarUpload } from '@/server/accounts/avatar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/users/me/avatar/uploads` — permission to send the picture, and nothing else.
 *
 * It answers with a presigned `PUT` bound to a server-minted `avatars/` key and to the content type
 * it was signed for, good for one hour. A refused format or an oversized declaration gets no URL at
 * all, which is the point of minting the grant only after both checks pass. Nothing is written to
 * the database here; an upload whose finalisation never arrives is an orphan object nobody can see.
 */
export const POST = apiRoute(SESSION, async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const grant: UploadGrantPayload = await grantAvatarUpload(context.actor, body);
  return grant;
});
