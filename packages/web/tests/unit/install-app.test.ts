import { describe, expect, it } from 'vitest';
import { isInstalledIn, type InstallView } from '@/app/(member)/install-app';

/**
 * **When the member menu offers "Install app", and when it keeps quiet**, decided over hand-made
 * windows in the manner of platform.test.ts. The row renders nothing once this answers `true`,
 * so each `true` below is a member who is not told to install what they are already running.
 */

const standalone = (matches: boolean): NonNullable<InstallView['matchMedia']> => {
  return (query) => ({ matches: query === '(display-mode: standalone)' && matches });
};

describe('isInstalledIn', () => {
  it('is false in a browser tab, which is the case that gets an offer', () => {
    expect(isInstalledIn({ matchMedia: standalone(false), navigator: {} })).toBe(false);
  });

  it('is false for a window that cannot even be asked, rather than throwing', () => {
    expect(isInstalledIn({})).toBe(false);
  });

  it('is true inside the store shell on either platform, whatever display mode says', () => {
    for (const platform of ['ios', 'android']) {
      expect(
        isInstalledIn({
          Capacitor: { getPlatform: () => platform },
          matchMedia: standalone(false),
          navigator: { standalone: false },
        }),
      ).toBe(true);
    }
  });

  it('treats a bridge that answers web as a browser, so the offer is not lost to a stray global', () => {
    expect(
      isInstalledIn({ Capacitor: { getPlatform: () => 'web' }, matchMedia: standalone(false) }),
    ).toBe(false);
  });

  it('is true for the installed PWA, by display mode or by the older iOS flag', () => {
    expect(isInstalledIn({ matchMedia: standalone(true), navigator: {} })).toBe(true);
    expect(isInstalledIn({ matchMedia: standalone(false), navigator: { standalone: true } })).toBe(
      true,
    );
  });
});
