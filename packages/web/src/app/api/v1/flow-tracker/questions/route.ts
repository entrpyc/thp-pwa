import type { FlowQuestionBankPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { readFlowQuestionBankFor } from '@/server/flow-tracker/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/flow-tracker/questions` — **what a session over any pick would ask**
 * ([3.18.18](docs/project/prd.md)). The device keeps the answer so a session can be started with
 * no connection and sent when it returns. Behind `flow.read`, like the start screen's own list:
 * it shows nothing a member could not already be asked.
 */
export const GET = apiRoute(permits('flow.read'), async (_request, context) => {
  const payload: FlowQuestionBankPayload = await readFlowQuestionBankFor(context.actor);
  return payload;
});
