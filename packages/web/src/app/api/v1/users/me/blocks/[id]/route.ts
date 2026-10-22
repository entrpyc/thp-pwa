import type { BlockListPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { blockMemberFor, unblockMemberFor } from '@/server/blocks/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/users/me/blocks/:id` — **stop seeing this member**, and stop them acting on what
 * you write.
 *
 * `POST` rather than `PUT`, although it is idempotent: the resource being created is the pair,
 * and the body is empty — there is nothing about a block a member gets to say beyond who. Blocking
 * yourself is `invalid_input`; an id that is nobody is `not_found`; blocking somebody already
 * blocked is a success that changes nothing. The answer is the list as it now stands.
 */
export const POST = apiRoute(permits('block.create'), async (_request, context) => {
  const payload: BlockListPayload = await blockMemberFor(
    context.actor,
    await routeParam(context.params, 'id'),
  );
  return payload;
});

/**
 * `DELETE /api/v1/users/me/blocks/:id` — **see this member again.**
 *
 * Unblocking somebody not on the list succeeds: the member asked for an end state and has it.
 * The notes, replies and reactions the block was hiding are in the next read; nothing was
 * deleted while it stood, so nothing has to be restored.
 */
export const DELETE = apiRoute(permits('block.remove'), async (_request, context) => {
  const payload: BlockListPayload = await unblockMemberFor(
    context.actor,
    await routeParam(context.params, 'id'),
  );
  return payload;
});
