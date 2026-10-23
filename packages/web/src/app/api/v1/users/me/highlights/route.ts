import type { HighlightListPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { listHighlightsFor, pinHighlightFor } from '@/server/highlights/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/users/me/highlights` — **the member's playlist**, newest pinned first
 * ([3.15.5](docs/project/prd.md), [3.15.6](docs/project/prd.md)).
 *
 * `me` rather than an id in the path, exactly as the blocked list: the only playlist anybody may
 * read is their own ([3.15.9](docs/project/prd.md)), and a path that could name somebody else's
 * would need an ownership rule to refuse what it should never have been able to express. No
 * admin route lists anybody's.
 */
export const GET = apiRoute(permits('highlight.list'), async (_request, context) => {
  const payload: HighlightListPayload = await listHighlightsFor(context.actor);
  return payload;
});

/**
 * `POST /api/v1/users/me/highlights` — **pin a teaching, a moment of one, or a note of your own**
 * ([3.15.1](docs/project/prd.md)–[3.15.3](docs/project/prd.md)). The body says which; the answer
 * is the list as it now stands. Pinning what is already pinned succeeds and changes nothing.
 */
export const POST = apiRoute(permits('highlight.create'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: HighlightListPayload = await pinHighlightFor(context.actor, body);
  return payload;
});
