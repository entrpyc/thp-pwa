import type { TagQuestionsPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { addTagQuestionFor, listTagQuestionsFor } from '@/server/flow-tracker/questions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/tags/{id}/questions` — **a tag's Flow Tracker question bank**
 * ([3.14.11](docs/project/prd.md)). `GET` lists it, oldest first; `POST` adds a question. Both
 * answer the bank as it now stands.
 */
export const GET = apiRoute(permits('flow.bank.manage'), async (_request, context) => {
  const payload: TagQuestionsPayload = await listTagQuestionsFor(
    context.actor,
    await routeParam(context.params, 'id'),
  );
  return payload;
});

export const POST = apiRoute(permits('flow.bank.manage'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: TagQuestionsPayload = await addTagQuestionFor(
    context.actor,
    await routeParam(context.params, 'id'),
    body,
  );
  return payload;
});
