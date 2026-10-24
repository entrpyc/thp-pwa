import { type EnvSource, isExternalMocked } from '../mock';

/**
 * **One reader for whether the analytics tool is on, shared by every process that sends to it**
 * (docs/project/observability.md § 6.7).
 *
 * The client inlines `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` at build time; the
 * API and the worker read `POSTHOG_KEY` and `POSTHOG_HOST` at runtime. Three readers of the same
 * decision would be three places for the mock switch to be forgotten, so the decision is made
 * here, once, and each side hands in its own variable names. `tests/guards/mock-switch.test.ts`
 * holds all three to the same answer.
 *
 * **Analytics is a production-only concern.** Whatever the key and the mock switch say, the reader
 * answers `null` unless `NODE_ENV` is `production`: `next dev`, a test run and a local build of
 * any other kind send nothing, so a key left in a development `.env` cannot put a developer's
 * clicks — or a developer's stack traces — into the production project.
 *
 * Pure, and it never reads `process.env` itself: this package is importable by the client.
 */

/** The one value of `NODE_ENV` under which analytics may be on. */
export const ANALYTICS_PRODUCTION_ENVIRONMENT = 'production';

/** The runtime pair the API and the worker read. The client's `NEXT_PUBLIC_` pair lives in its adapter. */
export const SERVER_ANALYTICS_KEY_VARIABLE = 'POSTHOG_KEY';
export const SERVER_ANALYTICS_HOST_VARIABLE = 'POSTHOG_HOST';

export interface AnalyticsConfig {
  /** The project's public key. Public by design: it can only write events. */
  readonly key: string;
  /** The ingestion host, with no trailing slash. */
  readonly host: string;
}

/**
 * `null` means analytics is off: not a production build, mocked, or no key. A key without a host is
 * refused by name rather than defaulted, because which region the data lands in is a decision
 * nobody should make on the operator's behalf.
 */
export function readAnalyticsConfigNamed(
  env: EnvSource,
  names: { readonly key: string; readonly host: string },
): AnalyticsConfig | null {
  if (env['NODE_ENV'] !== ANALYTICS_PRODUCTION_ENVIRONMENT) return null;
  if (isExternalMocked(env)) return null;
  const key = (env[names.key] ?? '').trim();
  if (key === '') return null;
  const host = (env[names.host] ?? '').trim();
  if (host === '') {
    throw new Error(`${names.host} is not set but ${names.key} is — see .env.example.`);
  }
  return { key, host: host.replace(/\/+$/, '') };
}

/** The server-side decision, under the runtime names, for the API and the worker alike. */
export function readServerAnalyticsConfig(env: EnvSource): AnalyticsConfig | null {
  return readAnalyticsConfigNamed(env, {
    key: SERVER_ANALYTICS_KEY_VARIABLE,
    host: SERVER_ANALYTICS_HOST_VARIABLE,
  });
}
