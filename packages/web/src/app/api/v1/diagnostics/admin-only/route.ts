import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { assertDiagnosticsEnabled } from '@/server/api/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * An admin-only route that does nothing, so that "the refusal is the API's, not the client's" is a
 * thing a test can drive with each role rather than a claim about intent. It is the only route in
 * step 2 whose access differs between the two roles.
 */
export const GET = apiRoute(permits('diagnostics.admin'), (_request, context) => {
  assertDiagnosticsEnabled();
  return { adminOnly: true, actorId: context.actor.id };
});
