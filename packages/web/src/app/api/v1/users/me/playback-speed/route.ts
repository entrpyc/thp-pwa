import { SESSION } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { writePlaybackSpeed } from '@/server/playback/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PUT /api/v1/users/me/playback-speed` — **the speed this account hears every teaching at**
 * (Story 4 Ticket 03, [3.2.4](docs/project/prd.md)).
 *
 * `me` rather than an id in the path, and a session rather than a policy action: the only account
 * anybody may set this on is their own, and a path that could name somebody else's would need an
 * ownership rule to refuse what it should never have been able to express.
 *
 * A value outside the six is refused here **and** by the check constraint on the column, so the
 * column cannot hold a rate no control can produce.
 */
export const PUT = apiRoute(SESSION, async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return writePlaybackSpeed(context.actor, body);
});
