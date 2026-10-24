import type { TagQuestionsPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { editTagQuestionFor, removeTagQuestionFor } from '@/server/flow-tracker/questions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/tags/{id}/questions/{questionId}` — one question of a tag's bank
 * ([3.14.11](docs/project/prd.md)). `PUT` rewrites it, `DELETE` removes it; both answer the bank
 * as it now stands.
 */
export const PUT = apiRoute(permits('flow.bank.manage'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: TagQuestionsPayload = await editTagQuestionFor(
    context.actor,
    await routeParam(context.params, 'id'),
    await routeParam(context.params, 'questionId'),
    body,
  );
  return payload;
});

export const DELETE = apiRoute(permits('flow.bank.manage'), async (_request, context) => {
  const payload: TagQuestionsPayload = await removeTagQuestionFor(
    context.actor,
    await routeParam(context.params, 'id'),
    await routeParam(context.params, 'questionId'),
  );
  return payload;
});
