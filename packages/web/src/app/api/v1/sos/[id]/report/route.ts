import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { reportSignalFor } from '@/server/sos/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/sos/:id/report` — **ask an admin to look at this prayer request, or at one reply
 * on it** (Apple guideline 1.2, Google Play's user-generated-content policy) — the note report's
 * twin for the SOS channel ([3.16](docs/project/prd.md)).
 *
 * One route for the request and its replies, as every reply route under `/sos` is addressed
 * through the signal: the body names `replyId` for a reply and leaves it out for the request. The
 * rest of the body is the note report's — a reason from the shared list and an optional sentence.
 * Your own is `invalid_input`; a request or a reply hidden from you is `not_found`; a second
 * report of the same thing by the same member answers the first report's id and writes nothing.
 * `201`, because a row was created — or `200` when it was not.
 */
export const POST = apiRoute(permits('sos.report'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const { payload, created } = await reportSignalFor(
    context.actor,
    await routeParam(context.params, 'id'),
    body,
  );
  return created ? new ApiSuccess(payload, 201) : payload;
});
