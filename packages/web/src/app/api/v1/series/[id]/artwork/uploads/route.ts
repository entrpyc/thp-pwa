import type { UploadGrantPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { grantArtworkUpload } from '@/server/series/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/series/{id}/artwork/uploads` — permission to send the cover, and nothing else.
 *
 * It answers with a presigned `PUT` bound to a server-minted `artwork/` key and to the content type
 * it was signed for, good for one hour. **A refused format or an oversized declaration gets no URL
 * at all**, which is the point of minting the grant only after both checks pass.
 *
 * Nothing is written to the database here. An upload whose finalisation never arrives is an orphan
 * object nobody can see — the deliberate cost of a store with no delete on it (scope tdd 1.1).
 */
export const POST = apiRoute(permits('series.artwork'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const grant: UploadGrantPayload = await grantArtworkUpload(
    context.actor,
    await routeParam(context.params, 'id'),
    body,
  );
  return grant;
});
