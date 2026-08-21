import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { rerunStep } from '@/server/pipeline/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/recordings/:id/rerun` — run one step of this recording again
 * (docs/project/prd.md, 3.21.2.4).
 *
 * **The step is in the body, not in the path.** One route for every step there will ever be, so
 * [§3.4](docs/project/prd.md)'s `process_audio` arriving needs no new file here — it is already
 * a value `PIPELINE_STEPS` carries.
 *
 * `POST` to a named sub-resource rather than a second `POST /recordings`, for the same reason
 * deactivation is a sub-resource of an account: what this does is not create a recording.
 */
export const POST = apiRoute(permits('pipeline.rerun'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return rerunStep(context.actor, await routeParam(context.params, 'id'), body);
});
