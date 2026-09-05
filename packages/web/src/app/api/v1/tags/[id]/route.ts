import type { DeleteTagPayload, TagPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { deleteTagFor, renameTagFor } from '@/server/tags/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/tags/{id}` — one tag ([4.7](docs/project/prd.md)).
 *
 * `PATCH` renames it everywhere at once: one column on one row, and every recording and series
 * that carries it prints the new name because each was only ever pointing at the id. `DELETE`
 * removes it from everything and answers with how many things that was.
 *
 * Two actions rather than one `tag.manage`, for the reason every pair in the policy table is two:
 * fixing a spelling across the library and removing a category from it are the same question only
 * while there are two roles.
 */

export const PATCH = apiRoute(permits('tag.rename'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: TagPayload = {
    tag: await renameTagFor(context.actor, await routeParam(context.params, 'id'), body),
  };
  return payload;
});

export const DELETE = apiRoute(permits('tag.delete'), async (_request, context) => {
  const payload: DeleteTagPayload = await deleteTagFor(
    context.actor,
    await routeParam(context.params, 'id'),
  );
  return payload;
});
