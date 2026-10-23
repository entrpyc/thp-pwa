import type { AnalyticsInstallSource } from '@thp/shared';
import { type EnvSource, isExternalMocked } from '@thp/shared/mock';
import { type ShellView, shellPlatformOf } from '@/client/platform';

/**
 * **What the analytics adapter reads before it does anything** — pure, so a test can hand it an
 * environment and a window and see what it decides (docs/project/observability.md § 6.7).
 *
 * The literals `process.env.NEXT_PUBLIC_…` are inlined at build time and therefore live in the
 * adapter, written out in full; this file only takes what the adapter read. The mock switch
 * reaches the client as `NEXT_PUBLIC_THP_MOCK_EXTERNAL`, mirrored from `THP_MOCK_EXTERNAL` by
 * next.config.ts, so a development build or a test run carries a client that sends nothing —
 * the same promise the four server-side adapters make through `tests/guards/mock-switch.test.ts`.
 *
 * **Analytics is a production-only concern.** Whatever the key and the mock switch say, the reader
 * answers `null` unless `NODE_ENV` is `production`: `next dev`, a test run and a local build
 * of any other kind send nothing, so a key left in a development `.env` cannot put a developer's
 * clicks into the member insights.
 */

export const ANALYTICS_KEY_VARIABLE = 'NEXT_PUBLIC_POSTHOG_KEY';
/** The one value of `NODE_ENV` under which analytics may be on. */
export const ANALYTICS_PRODUCTION_ENVIRONMENT = 'production';

/**
 * **Where the browser sends events: a path on the app's own origin, not PostHog's host.**
 *
 * Content blockers work from lists of third-party hosts, and `eu.i.posthog.com` is on them, so a
 * browser with one installed sends nothing and the member insights undercount everyone who runs
 * one. nginx forwards this path to the EU host (`deploy/nginx/thp.conf`), which makes every
 * analytics request same-origin; `NEXT_PUBLIC_POSTHOG_HOST` names the upstream nginx forwards to,
 * and the client never names it in a request.
 *
 * The word is deliberately bland. Filter lists match paths too, and `/analytics`, `/ingest`,
 * `/posthog`, `/track` and `/collect` are all on them.
 *
 * Named once, here, and held equal to the nginx `location` by
 * `tests/guards/analytics-proxy.test.ts`, so the two cannot drift apart.
 */
export const ANALYTICS_PROXY_PATH = '/relay';
export const ANALYTICS_HOST_VARIABLE = 'NEXT_PUBLIC_POSTHOG_HOST';

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
export function readAnalyticsConfig(env: EnvSource): AnalyticsConfig | null {
  return readAnalyticsConfigNamed(env, { key: ANALYTICS_KEY_VARIABLE, host: ANALYTICS_HOST_VARIABLE });
}

/**
 * The same decision under other variable names — the server reads `POSTHOG_KEY` and
 * `POSTHOG_HOST` at runtime where the client inlines the `NEXT_PUBLIC_` pair at build time, and
 * one reader is what keeps the two sides' answers the same.
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

/**
 * The parts of a window the install-source question reads. The Capacitor bridge is the shell
 * reader's (`ShellView`), so that there is one place that knows what the bridge looks like.
 */
export interface InstallSourceView extends ShellView {
  readonly matchMedia?: (query: string) => { readonly matches: boolean };
  readonly navigator?: { readonly standalone?: boolean };
}

/**
 * How the app was opened: a store build, an installed web app, or a browser tab. Read once at
 * start-up and sent with every event, so insights can keep Web Vitals from a web view apart from a
 * browser's and count installs.
 */
export function detectInstallSource(view: InstallSourceView): AnalyticsInstallSource {
  const platform = shellPlatformOf(view);
  if (platform === 'ios') return 'ios_store';
  if (platform === 'android') return 'android_store';
  if (view.matchMedia?.('(display-mode: standalone)').matches === true) return 'pwa';
  // Safari on iOS reports an installed web app here rather than through display-mode.
  if (view.navigator?.standalone === true) return 'pwa';
  return 'browser';
}

/**
 * The properties PostHog's client adds to every event that carry a URL, a path or a referrer.
 * Removed from every event before it leaves, because a URL carries ids and can carry a query,
 * and the vocabulary sends the route pattern and the id as their own properties instead.
 * `$set` and `$set_once` are the person-property envelopes; the same keys are stripped inside them.
 */
const URL_PROPERTY_KEYS = [
  '$current_url',
  '$pathname',
  '$host',
  '$referrer',
  '$referring_domain',
  '$initial_current_url',
  '$initial_pathname',
  '$initial_host',
  '$initial_referrer',
  '$initial_referring_domain',
  '$prev_pageview_pathname',
  '$ip',
];

export function stripUrlProperties<T extends Record<string, unknown>>(properties: T): T {
  const clean: Record<string, unknown> = { ...properties };
  for (const key of URL_PROPERTY_KEYS) delete clean[key];
  for (const envelope of ['$set', '$set_once']) {
    const inner = clean[envelope];
    if (typeof inner === 'object' && inner !== null) {
      const innerClean: Record<string, unknown> = { ...(inner as Record<string, unknown>) };
      for (const key of URL_PROPERTY_KEYS) delete innerClean[key];
      clean[envelope] = innerClean;
    }
  }
  return clean as T;
}
