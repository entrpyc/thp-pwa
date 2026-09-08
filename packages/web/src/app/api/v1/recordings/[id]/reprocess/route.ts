import type { ReprocessPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { reprocessRecording } from '@/server/sound-profile/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/recordings/:id/reprocess` — produce this recording's playback rendition again
 * under the profile in force, and only the rendition ([3.4.7](docs/project/prd.md),
 * [3.4.8](docs/project/prd.md)).
 *
 * A route of its own rather than a step name sent to `…/rerun`, because the two are different
 * acts with different consequences: `rerun` of `process_audio` runs the whole chain behind it
 * (transcription, drafts, chapters), and this runs nothing behind it at all. Putting both behind
 * one route would make the difference a value in a body, which is the place a difference like
 * that gets lost.
 *
 * `pipeline.rerun`: it is a re-run of a step, and the same operator who may press the other one
 * may press this.
 */
export const POST = apiRoute(permits('pipeline.rerun'), async (_request, context) => {
  const payload: ReprocessPayload = await reprocessRecording(
    context.actor,
    await routeParam(context.params, 'id'),
  );
  return new ApiSuccess(payload, 202);
});
