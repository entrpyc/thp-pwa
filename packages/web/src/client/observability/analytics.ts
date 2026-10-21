import posthog from 'posthog-js';
import { sanitiseAnalyticsProperties, type AnalyticsPerson, type TrackFunction } from '@thp/shared';
import { detectInstallSource, readAnalyticsConfig, stripUrlProperties } from './config';

/**
 * **The only file that imports `posthog-js`** (docs/project/observability.md § 6.1;
 * `tests/guards/analytics-boundary.test.ts` holds it).
 *
 * Three verbs and nothing else: start, say who this is, say what happened. Every one is
 * fire-and-forget and swallows its own failure — analytics never blocks or fails anything
 * (observability.md § 6.8) — and every property that leaves goes through the vocabulary's
 * sanitiser first, so what reaches the tool is what the table in `@thp/shared` names and no more.
 *
 * The `process.env.NEXT_PUBLIC_…` reads are written out in full because Next inlines them at build
 * time by literal name; a read through a variable key would inline nothing.
 */

type State = 'idle' | 'on' | 'off';
let state: State = 'idle';

/**
 * Start the SDK, once. Returns whether analytics is on. Off when mocked, when no key is configured,
 * or outside a browser — and off, with one console line, when the SDK itself refuses to start.
 */
export function initAnalytics(): boolean {
  if (state !== 'idle') return state === 'on';
  try {
    const config = readAnalyticsConfig({
      NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
      NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      THP_MOCK_EXTERNAL: process.env.NEXT_PUBLIC_THP_MOCK_EXTERNAL,
    });
    if (config === null || typeof window === 'undefined') {
      state = 'off';
      return false;
    }
    posthog.init(config.key, {
      api_host: config.host,
      // The project settings say the same (observability.md § 5.5); the client says it too, so a
      // setting changed by hand in the browser does not change what leaves the product.
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_heatmaps: false,
      capture_performance: false,
      disable_session_recording: true,
      disable_surveys: true,
      // Nothing is fetched from PostHog's CDN at runtime: no recorder, no survey widget.
      disable_external_dependency_loading: true,
      // A person exists only once identified at sign-in, never for an anonymous visit.
      person_profiles: 'identified_only',
      persistence: 'localStorage+cookie',
      // The SDK stamps every event with the URL it happened on. The vocabulary sends the route
      // pattern and the id instead, and nothing with a path in it leaves.
      sanitize_properties: (properties) => stripUrlProperties(properties),
    });
    posthog.register({
      app_version: process.env.NEXT_PUBLIC_APP_VERSION || 'dev',
      install_source: detectInstallSource(window as unknown as Parameters<typeof detectInstallSource>[0]),
    });
    state = 'on';
    return true;
  } catch (error) {
    state = 'off';
    console.error('Analytics did not start; nothing will be sent.', error);
    return false;
  }
}

/** This is who: the account's opaque id, never the e-mail, and the person properties policy built. */
export function identifyAnalytics(person: AnalyticsPerson): void {
  if (state !== 'on') return;
  try {
    posthog.identify(person.accountId, { ...person.properties });
  } catch {
    // Nothing to do: the next event is sent against whatever identity the SDK holds.
  }
}

/** Sign-out. The next session on this browser starts anonymous rather than as the last member. */
export function resetAnalytics(): void {
  if (state !== 'on') return;
  try {
    posthog.reset();
  } catch {
    // As above.
  }
}

/** Say what happened. Typed by the vocabulary; sanitised by it again at runtime. */
export const track: TrackFunction = (name, properties) => {
  if (state !== 'on') return;
  const clean = sanitiseAnalyticsProperties(name, properties as Readonly<Record<string, unknown>>);
  if (clean === null) return;
  try {
    posthog.capture(name, clean);
  } catch {
    // A dropped event costs a count, not a member anything.
  }
};
