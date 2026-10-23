import posthog from 'posthog-js';
import { sanitiseAnalyticsProperties, type AnalyticsPerson, type TrackFunction } from '@thp/shared';
import {
  ANALYTICS_PROXY_PATH,
  detectInstallSource,
  readAnalyticsConfig,
  stripUrlProperties,
} from './config';

/**
 * **The only file that imports `posthog-js`** (docs/project/observability.md § 6.1;
 * `tests/guards/analytics-boundary.test.ts` holds it).
 *
 * Four verbs and nothing else: start, apply the member's consent, say who this is, say what
 * happened. Every one is fire-and-forget and swallows its own failure — analytics never blocks or
 * fails anything (observability.md § 6.8) — and every property that leaves goes through the
 * vocabulary's sanitiser first, so what reaches the tool is what the table in `@thp/shared` names
 * and no more.
 *
 * **Consent is withheld until it is granted.** The SDK starts opted out
 * (`opt_out_capturing_by_default`), and only {@link applyAnalyticsPreference} with the account's
 * preference opts it in. That is what makes "opted out before any event is sent" structural
 * rather than a matter of ordering: a start that nothing follows sends nothing, and the SDK's own
 * `reset()` — called at sign-out — returns it to the opted-out default, so the next member on this
 * browser is not collected on the strength of the last one's consent (Apple guideline 5.1.1(ii)).
 *
 * The `process.env.NEXT_PUBLIC_…` reads are written out in full because Next inlines them at build
 * time by literal name; a read through a variable key would inline nothing.
 */

type State = 'idle' | 'on' | 'off';
let state: State = 'idle';

/**
 * Whether the member has consented, as this module last applied it. Held here as well as in the
 * SDK so {@link track} can refuse without asking the SDK — and so a test can see the refusal
 * rather than trust that the SDK would have dropped the event.
 */
let consent: 'withheld' | 'granted' = 'withheld';

/**
 * Start the SDK, once. Returns whether it started. Off outside a production build, when mocked,
 * when no key is configured, or outside a browser — and off, with one console line, when the SDK
 * itself refuses to start.
 *
 * Started is not capturing: the SDK comes up opted out, and nothing leaves until
 * {@link applyAnalyticsPreference} is told the member has not opted out.
 */
export function initAnalytics(): boolean {
  if (state !== 'idle') return state === 'on';
  try {
    const config = readAnalyticsConfig({
      // Inlined by Next like the public pair below, so a development bundle carries the refusal.
      NODE_ENV: process.env.NODE_ENV,
      NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
      NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      THP_MOCK_EXTERNAL: process.env.NEXT_PUBLIC_THP_MOCK_EXTERNAL,
    });
    if (config === null || typeof window === 'undefined') {
      state = 'off';
      return false;
    }
    posthog.init(config.key, {
      // The app's own origin, forwarded to `config.host` by nginx — see ANALYTICS_PROXY_PATH. The
      // host itself is still read and validated so that a build with no EU host configured
      // refuses to start rather than forwarding to nowhere.
      api_host: ANALYTICS_PROXY_PATH,
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
      // Opted out until the account's preference says otherwise — see the file comment. The flag
      // the SDK persists for this is per browser; the account's preference is re-applied on every
      // mount and wins, so a stale flag from the last member here decides nothing.
      opt_out_capturing_by_default: true,
      // The SDK stamps every event with the URL it happened on. The vocabulary sends the route
      // pattern and the id instead, and nothing with a path in it leaves.
      sanitize_properties: (properties) => stripUrlProperties(properties),
    });
    state = 'on';
    return true;
  } catch (error) {
    state = 'off';
    console.error('Analytics did not start; nothing will be sent.', error);
    return false;
  }
}

/**
 * The two properties every event carries (`ANALYTICS_COMMON_PROPERTIES`). Registered on every
 * opt-in rather than once at start, because the SDK's `reset()` — at sign-out, and when consent
 * is withdrawn — clears super properties along with the identity, and an event after the next
 * opt-in with no version on it would be an event no insight could place.
 */
function registerCommonProperties(): void {
  posthog.register({
    app_version: process.env.NEXT_PUBLIC_APP_VERSION || 'dev',
    install_source: detectInstallSource(window as unknown as Parameters<typeof detectInstallSource>[0]),
  });
}

/**
 * **Apply the account's preference**: the member surface calls this when it mounts and whenever
 * the member changes the setting, so capturing follows the account without a reload.
 *
 * Turning off is `reset()` *then* `opt_out_capturing()`: the reset clears the distinct id and the
 * super properties from this browser's storage, so a member who withdrew consent leaves nothing
 * of themselves behind in it, and the explicit opt-out after it is what holds while the page
 * lives. The order matters — a reset after an opt-out would return the SDK to its default, which
 * happens to be opted out too, but a default is not a decision. Data already collected is not
 * touched: withdrawing consent is withdrawal going forward, and a deletion request is a different
 * feature with a server secret and a job behind it.
 *
 * Turning on is opt-in **without the SDK's own `$opt_in` event** — the vocabulary does not name
 * one and nothing new is collected by this ticket — then the common properties, then identify.
 * Identify is here rather than at start because identify is itself a send, and a send before the
 * preference was known is what this file exists to prevent.
 */
export function applyAnalyticsPreference(person: AnalyticsPerson, optedOut: boolean): void {
  if (state !== 'on') return;
  try {
    if (optedOut) {
      posthog.reset();
      posthog.opt_out_capturing();
      consent = 'withheld';
      return;
    }
    posthog.opt_in_capturing({ captureEventName: null });
    registerCommonProperties();
    consent = 'granted';
    identifyAnalytics(person);
  } catch (error) {
    // Refused rather than guessed: a failure applying consent leaves this module withholding it.
    consent = 'withheld';
    console.error('Analytics preference was not applied; nothing will be sent.', error);
  }
}

/** This is who: the account's opaque id, never the e-mail, and the person properties policy built. */
export function identifyAnalytics(person: AnalyticsPerson): void {
  if (state !== 'on' || consent !== 'granted') return;
  try {
    posthog.identify(person.accountId, { ...person.properties });
  } catch {
    // Nothing to do: the next event is sent against whatever identity the SDK holds.
  }
}

/**
 * Sign-out. The next session on this browser starts anonymous rather than as the last member —
 * and opted out, until its own preference is applied, because the reset returns the SDK to the
 * default the start chose.
 */
export function resetAnalytics(): void {
  if (state !== 'on') return;
  consent = 'withheld';
  try {
    posthog.reset();
  } catch {
    // As above.
  }
}

/** Say what happened. Typed by the vocabulary; sanitised by it again at runtime. */
export const track: TrackFunction = (name, properties) => {
  if (state !== 'on' || consent !== 'granted') return;
  const clean = sanitiseAnalyticsProperties(name, properties as Readonly<Record<string, unknown>>);
  if (clean === null) return;
  try {
    posthog.capture(name, clean);
  } catch {
    // A dropped event costs a count, not a member anything.
  }
};
