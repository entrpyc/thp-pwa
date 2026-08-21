import type { PipelineListPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { readPipelineStatus } from '@/server/pipeline/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/pipeline` — what the pipeline is doing to every recording.
 *
 * One query over the job ledger, which is what docs/project/prd.md 3.19.4 asks for in place of
 * log-reading. Admin-only through the policy module, and refused there rather than by the panel:
 * the page gate decides what to render and authorises nothing.
 *
 * No pagination and no filters. There are five recordings, and a control nobody needs is a control
 * somebody has to maintain.
 */
export const GET = apiRoute(permits('pipeline.read'), async (_request, context) => {
  const payload: PipelineListPayload = await readPipelineStatus(context.actor);
  return payload;
});
