import { CORRELATION_ID_HEADER, type ApiErrorBody } from '@thp/shared';
import { randomUUID } from 'node:crypto';
import {
  UNGUARDED_FIXTURE_HEADER,
  UNGUARDED_FIXTURE_VALUE,
} from '@/server/api/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * **The negative control for the route sweep.** Deliberately written without `apiRoute`, because a
 * route that never calls the wrapper is exactly the case the wrapper's required-access argument
 * cannot catch — and the sweep test is what covers that gap.
 *
 * It answers `200` to an anonymous caller only when the request asks for it by header *and* the
 * diagnostics routes are enabled, so:
 *
 * - the sweep against the running server sees a refusal and passes, and
 * - the same sweep re-run with the header attached sees the leak and reports it, which is how the
 *   suite proves the guard can fail.
 *
 * In a deployment `ENABLE_DIAGNOSTIC_ROUTES` is unset and this refuses like everything else.
 */
export function GET(request: Request): Response {
  const enabled = process.env['ENABLE_DIAGNOSTIC_ROUTES'] === 'true';
  const asking = request.headers.get(UNGUARDED_FIXTURE_HEADER) === UNGUARDED_FIXTURE_VALUE;
  const correlationId = request.headers.get(CORRELATION_ID_HEADER) ?? randomUUID();
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    [CORRELATION_ID_HEADER]: correlationId,
  };

  if (enabled && asking) {
    return new Response(JSON.stringify({ unguarded: true }), { status: 200, headers });
  }

  const body: ApiErrorBody = {
    error: {
      code: 'unauthenticated',
      message: 'This request requires a signed-in session.',
      correlationId,
    },
  };
  return new Response(JSON.stringify(body), { status: 401, headers });
}
