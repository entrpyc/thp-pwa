import { afterEach, describe, expect, it, vi } from 'vitest';
import { shellPlatform, shellPlatformOf } from '@/client/platform';

/**
 * **The one reader for "is this a store build"** (docs/project/tdd.md decision 4.3), driven with
 * hand-made windows: the Capacitor bridge names a platform, a browser has no bridge, and a bridge
 * that answers `web` is still a browser.
 */

describe('shellPlatformOf', () => {
  it('names the store shell the bridge reports', () => {
    expect(shellPlatformOf({ Capacitor: { getPlatform: () => 'ios' } })).toBe('ios');
    expect(shellPlatformOf({ Capacitor: { getPlatform: () => 'android' } })).toBe('android');
  });

  it('is null in a browser, with no bridge or a bridge that says web', () => {
    expect(shellPlatformOf({})).toBeNull();
    expect(shellPlatformOf({ Capacitor: {} })).toBeNull();
    expect(shellPlatformOf({ Capacitor: { getPlatform: () => 'web' } })).toBeNull();
  });
});

describe('shellPlatform', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is null where there is no window at all, so a server render can ask', () => {
    expect(typeof window).toBe('undefined');
    expect(shellPlatform()).toBeNull();
  });

  it('reads the bridge off the real window when there is one', () => {
    vi.stubGlobal('window', { Capacitor: { getPlatform: () => 'android' } });
    expect(shellPlatform()).toBe('android');
    vi.stubGlobal('window', {});
    expect(shellPlatform()).toBeNull();
  });
});
