import type { ChapterQuestionPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { setChapterQuestionFor } from '@/server/flow-tracker/questions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PUT /api/v1/chapters/{id}/question` — **rewrite the Flow Tracker question on this chapter**
 * ([3.14.11](docs/project/prd.md)).
 *
 * Its own sub-resource rather than a fourth field on the chapter's `PUT`, because the two are
 * written by different hands for different reasons: a chapter edit restates what the chapter says
 * and where it starts, and a question edit changes what a member is asked about it. A question
 * typed before the step has written one is the question — the step then finds nothing missing.
 */
export const PUT = apiRoute(permits('flow.question.edit'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: ChapterQuestionPayload = await setChapterQuestionFor(
    context.actor,
    await routeParam(context.params, 'id'),
    body,
  );
  return payload;
});
