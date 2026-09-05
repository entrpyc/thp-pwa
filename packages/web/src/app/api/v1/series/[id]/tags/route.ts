import type { TagsPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { setSeriesTagsFor } from '@/server/tags/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PUT /api/v1/series/{id}/tags` — **the tags on this series, as a whole set**
 * ([4.7](docs/project/prd.md)).
 *
 * A sub-resource of the series, beside `artwork`, and the same shape as the recording's: the whole
 * set by name, replacing what was there, creating any name that is not yet a tag. A series' tags
 * are its own — nothing here reads or writes a tag on any recording in it.
 */
export const PUT = apiRoute(permits('tag.assign'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: TagsPayload = {
    tags: await setSeriesTagsFor(context.actor, await routeParam(context.params, 'id'), body),
  };
  return payload;
});
