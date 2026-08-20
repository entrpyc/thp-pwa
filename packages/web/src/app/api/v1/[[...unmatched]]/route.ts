import { apiRoute } from '@/server/api/route';
import { ApiError } from '@/server/api/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Anything under `/api/v1` that no route claims. Without this, Next.js answers an unknown API path
 * with an HTML 404 page, which a JSON client cannot read.
 */
const unmatched = apiRoute((request) => {
  throw ApiError.notFound(`No API route matches ${new URL(request.url).pathname}.`);
});

export const GET = unmatched;
export const POST = unmatched;
export const PUT = unmatched;
export const PATCH = unmatched;
export const DELETE = unmatched;
export const HEAD = unmatched;
export const OPTIONS = unmatched;
