import { PostHog } from 'posthog-node';
import {
  sanitiseAnalyticsProperties,
  type AnalyticsEventName,
  type AnalyticsProperties,
} from '@thp/shared';
import {
  exceptionProperties,
  normaliseException,
  type ExceptionContext,
} from '@thp/shared/observability/exceptions';
import { logger } from '@/server/observability/logger';
import { readServerAnalyticsConfig } from './analytics-config';

/**
 * **The only file in the API that imports `posthog-node`** (docs/project/observability.md § 6.1;
 * `tests/guards/analytics-boundary.test.ts` holds it).
 *
 * Two things leave from here. One event: a completion, which the progress write computes from
 * listening accumulated across visits and which therefore cannot be sent from any single visit's
 * client (observability.md § 5.3), held to the same vocabulary and the same sanitiser as the
 * client adapter. And **unhandled exceptions** (§ 5.6): the one catch block every `/api/v1` route
 * shares reports what it could not handle, with the correlation id that is already on the log
 * line and on the response, so an issue in the tool and the lines on the box are one search apart.
 *
 * An exception is reported with no person. It is a fact about the software, not about a member,
 * so the member's analytics preference has no bearing on it and nothing identifies who was
 * calling; the context is the route pattern, the method and the status (`exceptionProperties`),
 * and never the body.
 *
 * Fire-and-forget throughout. The client is built on first use and kept for the life of the
 * process; `flushAt: 1` sends each event as it happens, because completions and crashes are both
 * rare and a queue that waited for twenty of them would lose nineteen at a restart.
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

/** The process's release, stamped on everything that leaves so an issue can be placed on a deploy. */
function appVersion(): string {
  return process.env.NEXT_PUBLIC_APP_VERSION || 'dev';
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
      properties: { ...clean, app_version: appVersion() },
    });
  } catch (cause) {
    logger.warn('analytics.send.failed', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/**
 * The distinct id a server exception is filed under. The SDK requires one; a report with no
 * person behind it is filed under the process, so every API crash is one "person" in the tool
 * and no member is.
 */
export const API_EXCEPTION_DISTINCT_ID = 'thp-api';

/**
 * **Report an exception the API did not handle.** Called from the shared route wrapper's catch
 * block and from nowhere else; an `ApiError` is a refusal, not a crash, and is never reported.
 *
 * Returns whether a report was handed to the SDK, so the one caller can say so in its log line
 * and a test can see the decision without the network.
 */
export function captureServerException(
  cause: unknown,
  context: Omit<ExceptionContext, 'process'>,
): boolean {
  const posthog = instance();
  if (posthog === null) return false;
  try {
    posthog.captureException(normaliseException(cause), API_EXCEPTION_DISTINCT_ID, {
      ...exceptionProperties({ ...context, process: 'api' }),
      app_version: appVersion(),
      // No person profile for the process: the id above is a label, not somebody.
      $process_person_profile: false,
    });
    return true;
  } catch (sendFailure) {
    logger.warn('analytics.send.failed', {
      error: sendFailure instanceof Error ? sendFailure.message : String(sendFailure),
    });
    return false;
  }
}
