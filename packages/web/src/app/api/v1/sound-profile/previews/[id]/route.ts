import type { PreviewPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { readPreview } from '@/server/sound-profile/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/sound-profile/previews/:id` — one preview as it stands
 * ([3.4.6](docs/project/prd.md)).
 *
 * Pending or running: the settings and the start it was asked for. Failed: the reason. Succeeded:
 * two signed URLs, minted for this reader now and valid for an hour, never stored — the same rule
 * playback's grant keeps, for the same reason.
 */
export const GET = apiRoute(permits('sound-profile.update'), async (_request, context) => {
  const payload: PreviewPayload = await readPreview(
    context.actor,
    await routeParam(context.params, 'id'),
  );
  return payload;
});
