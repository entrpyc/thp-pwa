import type { TagListPayload, TagPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { createTag, listTagsFor } from '@/server/tags/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/tags` — the taxonomy ([4.7](docs/project/prd.md)).
 *
 * **Operator-only at both methods.** A member never asks for the list of tags: the tags they may
 * see travel on the recordings and series they may see, and a route that listed every tag would be
 * a route that named tags applied only to unpublished teachings. `tag.list` is the console's
 * question — every tag with how many things carry it — and `tag.create` adds a name to the set
 * without putting it on anything.
 */

/** Create a tag. `201` — a tag is a resource, and this is the request that created it. */
export const POST = apiRoute(permits('tag.create'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: TagPayload = { tag: await createTag(context.actor, body) };
  return new ApiSuccess(payload, 201);
});

/** Every tag, alphabetically, with its counts over every recording and series, published or not. */
export const GET = apiRoute(permits('tag.list'), async (_request, context) => {
  const payload: TagListPayload = { tags: await listTagsFor(context.actor) };
  return payload;
});
