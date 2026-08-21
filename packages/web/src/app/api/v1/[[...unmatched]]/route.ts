import { SESSION } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { ApiError } from '@/server/api/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Anything under `/api/v1` that no route claims. Without this, Next.js answers an unknown API path
 * with an HTML 404 page, which a JSON client cannot read.
 *
 * It requires a session like every other route, and that ordering matters: an anonymous caller is
 * refused *before* the question of whether the path exists is answered, so the API cannot be
 * mapped by probing for the difference between `unauthenticated` and `not_found`.
 */
const unmatched = apiRoute(SESSION, (request) => {
  throw ApiError.notFound(`No API route matches ${new URL(request.url).pathname}.`);
});

export const GET = unmatched;
export const POST = unmatched;
export const PUT = unmatched;
export const PATCH = unmatched;
export const DELETE = unmatched;
export const HEAD = unmatched;
export const OPTIONS = unmatched;
