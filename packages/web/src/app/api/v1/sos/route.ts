import { SESSION } from '@/server/api/access';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { listSignalsFor, raiseSignalFor } from '@/server/sos/service';
import { SOS_STATUS_PARAM } from '@thp/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/sos` — the group's prayer emergency channel ([3.16](docs/project/prd.md)).
 *
 * `SESSION` at both methods, and the service asks `sos.read` and `sos.raise` with the actor in
 * hand — the shape every route under `/notes` takes, so the decision is made in one module and
 * the route is only the wiring.
 */

/** The board's list: `?status=open` (the default) or `?status=resolved`, in urgency-then-recency order. */
export const GET = apiRoute(SESSION, async (request, context) =>
  listSignalsFor(context.actor, new URL(request.url).searchParams.get(SOS_STATUS_PARAM)),
);

/** Raise one. `201` — a signal is a resource, and this is the request that created it. */
export const POST = apiRoute(SESSION, async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return new ApiSuccess(await raiseSignalFor(context.actor, body), 201);
});
