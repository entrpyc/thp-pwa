import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { ApiError } from '@/server/api/errors';
import { assertDiagnosticsEnabled } from '@/server/api/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Throws a failure the route means to return — the handled-error path. */
export const GET = apiRoute(permits('diagnostics.run'), () => {
  assertDiagnosticsEnabled();
  throw ApiError.serviceUnavailable('The diagnostics dependency is deliberately unavailable.');
});
