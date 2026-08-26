import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { mintPlaybackGrant } from '@/server/playback/grant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/recordings/:id/playback` — **the short-lived signed `GET` a member listens through**
 * (Story 4 Ticket 02, [3.2.3](docs/project/prd.md), [§6](docs/project/prd.md) Security).
 *
 * Behind `recording.browse`, and the grant is minted only after the recording is confirmed
 * published. What comes back is a URL and its expiry and never the object key — the audio itself
 * travels from the object store to the browser and never through this process, which is what makes
 * scrubbing work without a CDN.
 *
 * The minting is one function (`mintPlaybackGrant`) and this route is its only caller. That is the
 * seam core-listening scope tdd § Extension points reserves for a processed
 * rendition, so it stays singular deliberately.
 */
export const GET = apiRoute(permits('recording.browse'), async (_request, context) =>
  mintPlaybackGrant(context.actor, await routeParam(context.params, 'id')),
);
