import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROLE, type AnalyticsPerson } from '@thp/shared';

/**
 * **The client adapter respects the member's analytics preference** — at start, and when it
 * changes under a running page (Apple guideline 5.1.1(ii)).
 *
 * The SDK is a stub, so what is asserted is the adapter's contract with it: that it starts opted
 * out, that nothing is identified or captured until consent is applied, that withdrawing consent
 * is a reset followed by an opt-out (in that order), and that restoring it opts in without the
 * SDK's own opt-in event, puts the common properties back, identifies again and lets events flow —
 * all without a reload. Each test imports the adapter afresh, because its state is module-level
 * by design: one start per page.
 */

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  register: vi.fn(),
  identify: vi.fn(),
  capture: vi.fn(),
  reset: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
}));

vi.mock('posthog-js', () => ({ default: sdk }));

const PERSON: AnalyticsPerson = {
  accountId: 'a3f1c2d4-0000-4000-8000-000000000001',
  properties: { role: ROLE.member },
};

async function freshAdapter() {
  vi.resetModules();
  return import('@/client/observability/analytics');
}

/** Which of the stub's methods were called, in the order they were. */
function callOrder(): string[] {
  return Object.entries(sdk)
    .flatMap(([name, fn]) => fn.mock.invocationCallOrder.map((order) => ({ name, order })))
    .sort((a, b) => a.order - b.order)
    .map(({ name }) => name);
}

beforeEach(() => {
  for (const fn of Object.values(sdk)) fn.mockReset();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test');
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://analytics.example.test');
  vi.stubEnv('NEXT_PUBLIC_THP_MOCK_EXTERNAL', 'false');
  vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '1.2.3');
  // Enough of a window for the adapter to agree it is in a browser; the install-source reader
  // treats what is missing as a plain browser tab.
  vi.stubGlobal('window', {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('at start', () => {
  it('starts the SDK opted out, and neither identifies nor captures until consent is applied', async () => {
    const adapter = await freshAdapter();

    expect(adapter.initAnalytics()).toBe(true);
    expect(sdk.init).toHaveBeenCalledOnce();
    expect(sdk.init.mock.calls[0]?.[1]).toMatchObject({ opt_out_capturing_by_default: true });

    adapter.identifyAnalytics(PERSON);
    adapter.track('$pageview', { route: '/', recording_id: null, series_id: null });

    expect(sdk.identify).not.toHaveBeenCalled();
    expect(sdk.capture).not.toHaveBeenCalled();
    expect(sdk.opt_in_capturing).not.toHaveBeenCalled();
  });

  it('for a member who opted out: resets, then opts out, and never identifies — first paint included', async () => {
    const adapter = await freshAdapter();
    adapter.initAnalytics();

    adapter.applyAnalyticsPreference(PERSON, true);
    adapter.track('$pageview', { route: '/', recording_id: null, series_id: null });
    adapter.track('speed_changed', { speed: 1.5 });

    expect(callOrder()).toEqual(['init', 'reset', 'opt_out_capturing']);
    expect(sdk.identify).not.toHaveBeenCalled();
    expect(sdk.capture).not.toHaveBeenCalled();
  });

  it('for a member who has not: opts in without the SDK’s own event, registers the common properties, identifies, and captures', async () => {
    const adapter = await freshAdapter();
    adapter.initAnalytics();

    adapter.applyAnalyticsPreference(PERSON, false);
    adapter.track('speed_changed', { speed: 1.5 });

    expect(callOrder()).toEqual(['init', 'opt_in_capturing', 'register', 'identify', 'capture']);
    expect(sdk.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: null });
    expect(sdk.register).toHaveBeenCalledWith({ app_version: '1.2.3', install_source: 'browser' });
    expect(sdk.identify).toHaveBeenCalledWith(PERSON.accountId, { role: ROLE.member });
    expect(sdk.capture).toHaveBeenCalledWith('speed_changed', { speed: 1.5 });
    expect(sdk.reset).not.toHaveBeenCalled();
  });

  it('touches the SDK not at all when analytics is not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    const adapter = await freshAdapter();

    expect(adapter.initAnalytics()).toBe(false);
    adapter.applyAnalyticsPreference(PERSON, false);
    adapter.track('speed_changed', { speed: 1.5 });

    for (const fn of Object.values(sdk)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('on toggle, without a reload', () => {
  it('stops capturing when turned off, and resumes — identified again — when turned back on', async () => {
    const adapter = await freshAdapter();
    adapter.initAnalytics();
    adapter.applyAnalyticsPreference(PERSON, false);
    adapter.track('speed_changed', { speed: 1.25 });
    expect(sdk.capture).toHaveBeenCalledTimes(1);

    // Off: the identity leaves the browser and the next event goes nowhere.
    adapter.applyAnalyticsPreference(PERSON, true);
    adapter.track('speed_changed', { speed: 1.5 });
    adapter.identifyAnalytics(PERSON);
    expect(sdk.reset).toHaveBeenCalledTimes(1);
    expect(sdk.opt_out_capturing).toHaveBeenCalledTimes(1);
    expect(sdk.capture).toHaveBeenCalledTimes(1);
    expect(sdk.identify).toHaveBeenCalledTimes(1);

    // On again: opted in, the common properties put back after the reset cleared them, the
    // account identified afresh, and the next event sent.
    adapter.applyAnalyticsPreference(PERSON, false);
    adapter.track('speed_changed', { speed: 2 });
    expect(sdk.opt_in_capturing).toHaveBeenCalledTimes(2);
    expect(sdk.register).toHaveBeenCalledTimes(2);
    expect(sdk.identify).toHaveBeenCalledTimes(2);
    expect(sdk.capture).toHaveBeenCalledTimes(2);
    expect(sdk.capture).toHaveBeenLastCalledWith('speed_changed', { speed: 2 });
  });

  it('withholds again after sign-out, until the next member’s preference is applied', async () => {
    const adapter = await freshAdapter();
    adapter.initAnalytics();
    adapter.applyAnalyticsPreference(PERSON, false);

    adapter.resetAnalytics();
    adapter.track('speed_changed', { speed: 1.5 });
    expect(sdk.capture).not.toHaveBeenCalled();

    adapter.applyAnalyticsPreference({ ...PERSON, accountId: 'b4e2d3c5-0000-4000-8000-000000000002' }, false);
    adapter.track('speed_changed', { speed: 1.5 });
    expect(sdk.capture).toHaveBeenCalledOnce();
  });

  it('withholds when the SDK refuses the preference, rather than guessing', async () => {
    const adapter = await freshAdapter();
    adapter.initAnalytics();
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    sdk.opt_in_capturing.mockImplementationOnce(() => {
      throw new Error('storage unavailable');
    });

    adapter.applyAnalyticsPreference(PERSON, false);
    adapter.track('speed_changed', { speed: 1.5 });

    expect(sdk.capture).not.toHaveBeenCalled();
    expect(sdk.identify).not.toHaveBeenCalled();
    silence.mockRestore();
  });
});
