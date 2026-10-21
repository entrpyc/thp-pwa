import { PostHog } from 'posthog-node';
import {
  sanitiseAnalyticsProperties,
  type AnalyticsEventName,
  type AnalyticsProperties,
} from '@thp/shared';
import { logger } from '@/server/observability/logger';
import { readServerAnalyticsConfig } from './analytics-config';

/**
 * **The only file that imports `posthog-node`** (docs/project/observability.md § 6.1;
 * `tests/guards/analytics-boundary.test.ts` holds it).
 *
 * One caller and one event: a completion, which the progress write computes from listening
 * accumulated across visits and which therefore cannot be sent from any single visit's client
 * (observability.md § 5.3). The same vocabulary and the same sanitiser as the client adapter, so
 * what leaves from here is held to the same table.
 *
 * Fire-and-forget throughout. The client is built on first use and kept for the life of the
 * process; `flushAt: 1` sends each event as it happens, because completions are rare and a queue
 * that waited for twenty of them would lose nineteen at a restart.
 */

let client: PostHog | null | undefined;

function instance(): PostHog | null {
  if (client !== undefined) return client;
  try {
    const config = readServerAnalyticsConfig();
    if (config === null) {
      client = null;
      return null;
    }
    const posthog = new PostHog(config.key, {
      host: config.host,
      flushAt: 1,
      // The server's address is not a member's, and the project discards client IPs anyway.
      disableGeoip: true,
    });
    posthog.on('error', (cause: unknown) => {
      logger.warn('analytics.send.failed', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });
    client = posthog;
  } catch (cause) {
    client = null;
    logger.warn('analytics.off', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return client;
}

/**
 * Say what happened, for whom. The distinct id is the account's opaque id — the same one the
 * client identifies with — so a server-sent event lands on the same person.
 */
export function trackFor<N extends AnalyticsEventName>(
  distinctId: string,
  name: N,
  properties: AnalyticsProperties<N>,
): void {
  const posthog = instance();
  if (posthog === null) return;
  const clean = sanitiseAnalyticsProperties(name, properties as Readonly<Record<string, unknown>>);
  if (clean === null) return;
  try {
    posthog.capture({
      distinctId,
      event: name,
      properties: { ...clean, app_version: process.env.NEXT_PUBLIC_APP_VERSION || 'dev' },
    });
  } catch (cause) {
    logger.warn('analytics.send.failed', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
