import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { assertDiagnosticsEnabled, BOOM_INTERNAL_MESSAGE } from '@/server/api/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Throws an ordinary, unhandled error — the `500` path. */
export const GET = apiRoute(permits('diagnostics.run'), () => {
  assertDiagnosticsEnabled();
  throw new Error(BOOM_INTERNAL_MESSAGE);
});
