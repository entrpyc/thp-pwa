import { PostHog } from 'posthog-node';
import { readServerAnalyticsConfig } from '@thp/shared/observability/analytics-config';
import {
  exceptionProperties,
  normaliseException,
  type ExceptionContext,
} from '@thp/shared/observability/exceptions';
import { logger } from '@thp/shared/observability/logger';

/**
 * **The only file in the worker that imports `posthog-node`** (docs/project/observability.md
 * § 5.6, § 6.1; `tests/guards/analytics-boundary.test.ts` holds it).
 *
 * The worker sends no analytics event — it has no member in front of it — and reports one thing:
 * **a job that failed**. `runJob` already writes the failure to the row and the whole error to the
 * log under the job's correlation id; this is the same failure handed to the error tracker under
 * the same id, so a new issue in the tool names the job, the step and the attempt, and a search
 * on the id in the pm2 logs finds the rest.
 *
 * Reported with no person and no recording content: the context is ids, the step name and a
 * count (`exceptionProperties`), and the error is bounded by `normaliseException` so a provider's
 * response echoed into a message cannot carry a transcript. The API's adapter makes the same
 * promise in the same words; the two are separate files because the two are separate processes
 * with separate dependency lists, not because they differ.
 *
 * Fire-and-forget. The same reader as the API decides whether it is on at all
 * (`POSTHOG_KEY`, `POSTHOG_HOST`, production only, silenced by the mock switch), and a worker
 * with nothing configured says so once at boot and does nothing after.
 */

/** The distinct id worker exceptions are filed under: the process, never a member. */
export const WORKER_EXCEPTION_DISTINCT_ID = 'thp-worker';

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** The surface of the SDK this adapter uses, so a test can hand in a stub. */
export interface ExceptionSink {
  captureException(
    error: unknown,
    distinctId?: string,
    additionalProperties?: Record<string | number, unknown>,
  ): void;
}

export interface ExceptionReporter {
  /** Report a failure, with its context. Never throws; answers whether a report was handed over. */
  report(cause: unknown, context: Omit<ExceptionContext, 'process'>): boolean;
}

export interface ExceptionReporterOptions {
  readonly env?: EnvSource;
  /** Replaces the SDK. When absent the SDK is built from `env`, or not at all. */
  readonly sink?: ExceptionSink | null;
  readonly appVersion?: string;
}

/** A reporter that reports nothing: what a development machine and every test gets. */
export const NO_EXCEPTION_REPORTER: ExceptionReporter = { report: () => false };

export function createExceptionReporter(options: ExceptionReporterOptions = {}): ExceptionReporter {
  const { env = process.env, appVersion = env['NEXT_PUBLIC_APP_VERSION'] || 'dev' } = options;
  const sink = options.sink === undefined ? buildSink(env) : options.sink;
  if (sink === null) return NO_EXCEPTION_REPORTER;

  return {
    report(cause, context) {
      try {
        sink.captureException(normaliseException(cause), WORKER_EXCEPTION_DISTINCT_ID, {
          ...exceptionProperties({ ...context, process: 'worker' }),
          app_version: appVersion,
          // No person profile for the process: the id above is a label, not somebody.
          $process_person_profile: false,
        });
        return true;
      } catch (sendFailure) {
        logger.warn('exceptions.send.failed', {
          error: sendFailure instanceof Error ? sendFailure.message : String(sendFailure),
        });
        return false;
      }
    },
  };
}

function buildSink(env: EnvSource): ExceptionSink | null {
  try {
    const config = readServerAnalyticsConfig(env);
    if (config === null) {
      logger.info('worker.exceptions.off', { reason: 'no error tracker is configured for this environment' });
      return null;
    }
    const posthog = new PostHog(config.key, {
      host: config.host,
      // A failure is rare and the process may be restarting; send each one as it happens.
      flushAt: 1,
      disableGeoip: true,
    });
    posthog.on('error', (cause: unknown) => {
      logger.warn('exceptions.send.failed', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });
    return posthog;
  } catch (cause) {
    logger.warn('worker.exceptions.off', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }
}
