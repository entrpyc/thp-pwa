import { pingDatabase } from '@thp/db';
import type { HealthPayload } from '@thp/shared';
import { apiRoute } from '@/server/api/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/health`
 *
 * Always answers `200` — the check itself succeeded — and puts the verdict in `status`. A degraded
 * database is a finding, not a failure of this endpoint, and keeping it a success response is what
 * lets the envelope rule ("failures are the error envelope") stay absolute. Monitoring reads
 * `status`, not the status code.
 *
 * `database.reachable` reflects a real round-trip query, never a configuration value.
 */
export const GET = apiRoute(async (): Promise<HealthPayload> => {
  const ping = await pingDatabase();
  return {
    status: ping.reachable ? 'ok' : 'degraded',
    database: { reachable: ping.reachable, latencyMs: ping.latencyMs },
  };
});
