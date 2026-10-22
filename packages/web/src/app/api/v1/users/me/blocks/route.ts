import type { BlockListPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { listBlocksFor } from '@/server/blocks/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/users/me/blocks` — **the members this account has chosen not to see**, by display
 * name, A to Z.
 *
 * `me` rather than an id in the path, exactly as the avatar and playback-speed routes: the only
 * blocked list anybody may read is their own, and a path that could name somebody else's would
 * need an ownership rule to refuse what it should never have been able to express. Who has
 * blocked *this* account is not listed by any route — a block is the blocker's to know.
 */
export const GET = apiRoute(permits('block.list'), async (_request, context) => {
  const payload: BlockListPayload = await listBlocksFor(context.actor);
  return payload;
});
