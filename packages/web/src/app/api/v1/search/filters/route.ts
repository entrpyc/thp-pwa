import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { searchFiltersFor } from '@/server/search/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/search/filters` — **what a member may narrow a search by**
 * ([3.10.8](docs/project/prd.md)): the series, tags and books present in the published library.
 *
 * Its own route rather than a field on every search answer, because it changes when the library
 * does and a search changes with every keystroke: the page asks once when it opens and keeps the
 * answer across searches. Behind the same action as the search, and not budgeted — nothing here
 * leaves the server.
 */
export const GET = apiRoute(permits('search.query'), async (_request, context) => {
  return searchFiltersFor(context.actor);
});
