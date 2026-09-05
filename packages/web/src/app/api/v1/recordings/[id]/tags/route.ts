import type { TagsPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { setRecordingTagsFor } from '@/server/tags/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PUT /api/v1/recordings/{id}/tags` — **the tags on this teaching, as a whole set**
 * ([4.7](docs/project/prd.md)).
 *
 * A sub-resource of the recording, beside `series`, `publish` and `summary`, and for the same
 * reason each of those is one: what this changes is not the recording's row. `PUT` rather than a
 * `POST`/`DELETE` pair because the row's chips and the database should agree after every request
 * with no sequence to replay — the client sends what it is showing, and reads back what is stored.
 *
 * Names, not ids: a name that is not yet a tag becomes one in this request, which is what makes
 * type-to-add one press rather than two.
 */
export const PUT = apiRoute(permits('tag.assign'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: TagsPayload = {
    tags: await setRecordingTagsFor(context.actor, await routeParam(context.params, 'id'), body),
  };
  return payload;
});
