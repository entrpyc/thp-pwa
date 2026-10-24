import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_HOST_VARIABLE,
  ANALYTICS_KEY_VARIABLE,
  ANALYTICS_PRODUCTION_ENVIRONMENT,
  detectInstallSource,
  readAnalyticsConfig,
  stripUrlProperties,
} from '@/client/observability/config';
import { pageviewProperties, routePattern } from '@/client/observability/route-pattern';

/**
 * **The decisions the analytics adapter makes before it sends anything**, driven without a
 * browser and without the SDK (docs/project/observability.md § 5.2, § 6.3, § 6.7): whether it is
 * on at all, how the app was opened, what a page view is allowed to say, and what the SDK's own
 * stamps may not say.
 */

const EU = 'https://eu.i.posthog.com';
const RECORDING = 'a3f1c2d4-0000-4000-8000-000000000001';
const CHAPTER = 'b4e2d3c5-0000-4000-8000-000000000002';

const PRODUCTION = { NODE_ENV: ANALYTICS_PRODUCTION_ENVIRONMENT };

describe('readAnalyticsConfig', () => {
  it('is on in production with a key and a host, with the host normalised', () => {
    expect(
      readAnalyticsConfig({ ...PRODUCTION, [ANALYTICS_KEY_VARIABLE]: 'phc_x', [ANALYTICS_HOST_VARIABLE]: `${EU}/` }),
    ).toEqual({ key: 'phc_x', host: EU });
  });

  it('is off outside production whatever the key says', () => {
    const configured = { [ANALYTICS_KEY_VARIABLE]: 'phc_x', [ANALYTICS_HOST_VARIABLE]: EU };
    expect(readAnalyticsConfig({ ...configured, NODE_ENV: 'development' })).toBeNull();
    expect(readAnalyticsConfig({ ...configured, NODE_ENV: 'test' })).toBeNull();
    expect(readAnalyticsConfig(configured)).toBeNull();
  });

  it('is off with no key, which is what the development template says', () => {
    expect(readAnalyticsConfig({ ...PRODUCTION, [ANALYTICS_HOST_VARIABLE]: EU })).toBeNull();
    expect(
      readAnalyticsConfig({ ...PRODUCTION, [ANALYTICS_KEY_VARIABLE]: '  ', [ANALYTICS_HOST_VARIABLE]: EU }),
    ).toBeNull();
  });

  it('refuses a key without a host by name rather than defaulting a region', () => {
    expect(() => readAnalyticsConfig({ ...PRODUCTION, [ANALYTICS_KEY_VARIABLE]: 'phc_x' })).toThrow(
      ANALYTICS_HOST_VARIABLE,
    );
  });
});

describe('detectInstallSource', () => {
  it('reads a store build off the Capacitor bridge first', () => {
    expect(detectInstallSource({ Capacitor: { getPlatform: () => 'ios' } })).toBe('ios_store');
    expect(detectInstallSource({ Capacitor: { getPlatform: () => 'android' } })).toBe('android_store');
  });

  it('reads an installed web app off display-mode, or off Safari’s own flag', () => {
    expect(detectInstallSource({ matchMedia: () => ({ matches: true }) })).toBe('pwa');
    expect(detectInstallSource({ matchMedia: () => ({ matches: false }), navigator: { standalone: true } })).toBe('pwa');
  });

  it('is a browser otherwise, including with nothing to read at all', () => {
    expect(detectInstallSource({ matchMedia: () => ({ matches: false }) })).toBe('browser');
    expect(detectInstallSource({})).toBe('browser');
  });
});

describe('routePattern', () => {
  it('puts the parameter names back where the values are', () => {
    expect(routePattern(`/recordings/${RECORDING}`, { id: RECORDING })).toBe('/recordings/[id]');
    expect(
      routePattern(`/recordings/${RECORDING}/chapters/${CHAPTER}`, { id: RECORDING, chapterId: CHAPTER }),
    ).toBe('/recordings/[id]/chapters/[chapterId]');
    expect(routePattern(`/series/${RECORDING}`, { id: RECORDING })).toBe('/series/[id]');
  });

  it('leaves a static route alone, with or without a trailing slash', () => {
    expect(routePattern('/', {})).toBe('/');
    expect(routePattern('/recordings/', {})).toBe('/recordings');
    expect(routePattern('/now-playing', {})).toBe('/now-playing');
  });
});

describe('pageviewProperties', () => {
  it('names the route and carries the id as its own property', () => {
    expect(pageviewProperties(`/recordings/${RECORDING}`, { id: RECORDING })).toEqual({
      route: '/recordings/[id]',
      recording_id: RECORDING,
      series_id: null,
    });
    expect(pageviewProperties(`/series/${RECORDING}`, { id: RECORDING })).toEqual({
      route: '/series/[id]',
      recording_id: null,
      series_id: RECORDING,
    });
    expect(pageviewProperties('/notifications', {})).toEqual({
      route: '/notifications',
      recording_id: null,
      series_id: null,
    });
  });

  it('says nothing for a page the vocabulary does not name', () => {
    expect(pageviewProperties('/admin/pipeline', {})).toBeNull();
    expect(pageviewProperties(`/onboarding/${RECORDING}`, { id: RECORDING })).toBeNull();
  });
});

describe('stripUrlProperties', () => {
  it('removes every URL, path and referrer the SDK stamps, at the top and inside the person envelopes', () => {
    const stripped = stripUrlProperties({
      route: '/recordings/[id]',
      $current_url: `https://thp.example/recordings/${RECORDING}?q=grace`,
      $pathname: `/recordings/${RECORDING}`,
      $referrer: 'https://example.com/',
      $lib: 'web',
      $set: { $initial_referrer: 'https://example.com/', role: 'member' },
      $set_once: { $initial_current_url: 'https://thp.example/', $initial_pathname: '/' },
    });
    expect(stripped).toEqual({
      route: '/recordings/[id]',
      $lib: 'web',
      $set: { role: 'member' },
      $set_once: {},
    });
  });
});

describe('stripUrlProperties, on a Web Vitals event', () => {
  // observability.md § 5.7: the number and its rating leave; the page URL, the raw performance
  // entries (an LCP entry names the element and its resource URL — a signed grant, for artwork)
  // and any attribution do not.
  it('keeps each metric’s numbers and drops its URL, entries and attribution', () => {
    const clean = stripUrlProperties({
      $current_url: 'https://thp.example/recordings/abc',
      $web_vitals_LCP_value: 1234,
      $web_vitals_LCP_event: {
        name: 'LCP',
        value: 1234,
        rating: 'good',
        delta: 1234,
        id: 'v3-1',
        navigationType: 'navigate',
        timestamp: 1,
        $current_url: 'https://thp.example/recordings/abc',
        $session_id: 's',
        entries: [{ url: 'https://media.example/artwork?X-Amz-Signature=secret', element: 'img' }],
        attribution: { element: 'img', url: 'https://media.example/artwork?X-Amz-Signature=secret' },
      },
      $web_vitals_CLS_value: 0.01,
    });
    expect(clean).toEqual({
      $web_vitals_LCP_value: 1234,
      $web_vitals_LCP_event: {
        name: 'LCP',
        value: 1234,
        rating: 'good',
        delta: 1234,
        id: 'v3-1',
        navigationType: 'navigate',
        timestamp: 1,
        $session_id: 's',
      },
      $web_vitals_CLS_value: 0.01,
    });
    expect(JSON.stringify(clean)).not.toContain('secret');
  });
});
