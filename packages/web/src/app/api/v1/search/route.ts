import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { searchFor } from '@/server/search/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/search?q=…` — **the one search entry point** ([3.10.1](docs/project/prd.md)).
 *
 * A `GET` with the query in the address rather than a `POST` with a body, because a search is a
 * read and its address is its identity: the results page is `/search?q=…` on the web origin and
 * this is the same parameters under the API prefix, so the page's URL and the request it makes
 * are one string built by one function (`searchPath` in `@thp/shared`).
 *
 * `search.query` admits every signed-in account and the budget behind it is per account
 * (`actor-limits.ts`). What comes back is decided inside the query by the visibility predicate,
 * so an admin here is a member here ([3.10.9](docs/project/prd.md)).
 *
 * **Two failure shapes, deliberately distinct** ([3.10.11](docs/project/prd.md)): the provider
 * failing is a `200` with `meaningAvailable: false`; the database failing is the `500` every route
 * answers through `apiRoute`. The page tells them apart by that.
 */
export const GET = apiRoute(permits('search.query'), async (request, context) => {
  return searchFor(context.actor, new URL(request.url).searchParams);
});
