import type { PreviewPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { requestPreview } from '@/server/sound-profile/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/sound-profile/previews` — hear a candidate profile before saving it
 * ([3.4.6](docs/project/prd.md)).
 *
 * A preview is a job: the encoder is on the worker host and the API is never in the audio path,
 * so what this creates is a row the worker will claim, and what it answers is that row, `202` —
 * accepted, not done. The console polls `GET …/previews/:id` until the row says otherwise.
 *
 * `sound-profile.update` rather than `.read`, because a preview is a save being decided: the
 * settings it renders are the form's, not the profile's.
 */
export const POST = apiRoute(permits('sound-profile.update'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: PreviewPayload = await requestPreview(context.actor, body);
  return new ApiSuccess(payload, 202);
});
