import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { grantUpload } from '@/server/recordings/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/recordings/uploads` — permission to send the bytes, and nothing else.
 *
 * It answers with a presigned `PUT` bound to a server-minted key and to the content type it was
 * signed for, good for one hour. **A refused format or an oversized declaration gets no URL at
 * all**, which is the point of minting the grant only after both checks pass: an error carrying a
 * URL is an error a client could ignore.
 *
 * This is not a recording. Nothing is written to the database here, and an upload whose
 * finalisation never arrives is an orphan object nobody can see — the deliberate cost of a store
 * with no delete on it ().
 */
export const POST = apiRoute(permits('recording.upload'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return grantUpload(context.actor, body);
});
