import { apiRoute } from '@/server/api/route';
import { assertDiagnosticsEnabled } from '@/server/api/diagnostics';
import { logger } from '@/server/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Logs a caller-controlled number of lines, optionally pausing between them so two requests
 * interleave. Used to prove that concurrent requests do not share a correlation id.
 */
export const GET = apiRoute(async (request, context) => {
  assertDiagnosticsEnabled();
  const url = new URL(request.url);
  const lines = Math.min(Number(url.searchParams.get('lines') ?? 3), 20);
  const delayMs = Math.min(Number(url.searchParams.get('delayMs') ?? 0), 500);
  const marker = url.searchParams.get('marker') ?? 'echo';

  for (let index = 0; index < lines; index += 1) {
    logger.info('diagnostics.echo', { marker, index });
    if (delayMs > 0) await sleep(delayMs);
  }

  return { marker, lines, correlationId: context.correlationId };
});
