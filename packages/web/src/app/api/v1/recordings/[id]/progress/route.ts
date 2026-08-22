import { SESSION } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { readPlaybackProgress, writePlaybackProgress } from '@/server/playback/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/recordings/:id/progress` — **where a member was up to, per recording**
 * (Story 4 Ticket 04, [3.2.5](docs/project/prd.md)).
 *
 * Behind a session and nothing more: the row is keyed on the caller's own id, so there is no
 * resource to authorise against — a member can only ever read or write their own position, because
 * the id in the path names the *recording* and the account comes from the session.
 *
 * **A single position, not a stream of events.** [§3.18](docs/project/prd.md)'s batch sync arrives
 * beside this endpoint rather than replacing it, which is the whole reason the client-owned shape
 * is not a dead end.
 */

/** Where this member had got to, or `null` on both fields when they have never been here. */
export const GET = apiRoute(SESSION, async (_request, context) =>
  readPlaybackProgress(context.actor, await routeParam(context.params, 'id')),
);

/** Store a position. Upserted on the pair, and the newest write is the one that stands. */
export const PUT = apiRoute(SESSION, async (request, context) => {
  const recordingId = await routeParam(context.params, 'id');
  const body: unknown = await request.json().catch(() => null);
  return writePlaybackProgress(context.actor, recordingId, body);
});
