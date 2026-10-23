import { SESSION } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { readSignalFor, removeSignalFor } from '@/server/sos/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `GET /api/v1/sos/:id` — one signal in full: its replies and who is praying ([3.16.5](docs/project/prd.md), 3.16.6). */
export const GET = apiRoute(SESSION, async (_request, context) =>
  readSignalFor(context.actor, await routeParam(context.params, 'id')),
);

/**
 * `DELETE /api/v1/sos/:id` — **an admin removes a signal entirely** ([3.16.11](docs/project/prd.md)).
 *
 * `SESSION` rather than `permits('sos.moderate')` so the refusal for a member reads the same as
 * every other owned-or-moderated route's, and so a missing signal is `not_found` after the policy
 * said yes rather than `forbidden` before anything was looked at.
 */
export const DELETE = apiRoute(SESSION, async (_request, context) =>
  removeSignalFor(context.actor, await routeParam(context.params, 'id')),
);
