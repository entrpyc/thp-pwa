import { permits } from '@/server/api/access';
import { chapterScopeParam, routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { readScriptureFor } from '@/server/scripture/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/recordings/:id/scripture` — **the passages a published teaching was built on**
 * (scope prd 3.4.2–scope prd 3.4.3).
 *
 * `recording.browse`, the same action the recording itself and its transcript are behind, reading
 * the same visibility condition. That is scope prd 3.2.13 written as a route:
 * references ride the recording's publication, so there is no second action to declare and no
 * second gate to keep in step. An unpublished id and an id that never existed answer the same
 * `not_found`.
 *
 * **Read-only, like every other scripture route.** What a teaching cites is decided in Pending
 * Reviews and nowhere else.
 */
export const GET = apiRoute(permits('recording.browse'), async (request, context) => {
  return readScriptureFor(
    context.actor,
    await routeParam(context.params, 'id'),
    // `?chapter=` narrows to the references anchored inside that chapter
    // ([3.22.14](docs/project/prd.md), [3.7.10](docs/project/prd.md)). A reference with no anchor is
    // in no chapter's answer, which is where 3.7.10 puts it.
    chapterScopeParam(request),
  );
});
