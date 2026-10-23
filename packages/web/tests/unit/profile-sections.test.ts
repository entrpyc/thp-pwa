import { describe, expect, it } from 'vitest';
import { NOTIFICATION_SETTINGS_PAGE_PATH, PROFILE_PAGE_PATH } from '@thp/shared';
import { PROFILE_SECTIONS, sectionFor } from '@/app/(member)/profile/sections';

/**
 * **The list the profile's section strip renders from** (docs/project/prd.md 3.1.12).
 *
 * The strip is `PROFILE_SECTIONS` and nothing else, so what a test can hold the strip to is the
 * list: that the identity page leads it, that every entry is a route under `/profile`, that no two
 * entries collide, and that the current mark follows the address — including the honest `null` for
 * an address under `/profile` that no section has claimed yet.
 */
describe('the profile sections', () => {
  it('open with the identity page at the profile root', () => {
    expect(PROFILE_SECTIONS[0]).toEqual({ id: 'identity', label: 'Profile', href: PROFILE_PAGE_PATH });
  });

  it('are each a distinct route under the profile, with a distinct id and label', () => {
    for (const section of PROFILE_SECTIONS) {
      expect(section.href === PROFILE_PAGE_PATH || section.href.startsWith(`${PROFILE_PAGE_PATH}/`)).toBe(
        true,
      );
      expect(section.href.endsWith('/')).toBe(false);
    }
    const distinct = (key: 'id' | 'href' | 'label') =>
      new Set(PROFILE_SECTIONS.map((section) => section[key])).size;
    expect(distinct('id')).toBe(PROFILE_SECTIONS.length);
    expect(distinct('href')).toBe(PROFILE_SECTIONS.length);
    expect(distinct('label')).toBe(PROFILE_SECTIONS.length);
  });

  it('lists settings, notifications and downloads beside the identity page, in that order', () => {
    expect(PROFILE_SECTIONS.map((section) => section.id)).toEqual([
      'identity',
      'settings',
      'notifications',
      'downloads',
    ]);
    expect(PROFILE_SECTIONS[2]?.href).toBe(NOTIFICATION_SETTINGS_PAGE_PATH);
  });
});

describe('which section an address is in', () => {
  it('is the identity page at the root alone, trailing slash or not', () => {
    expect(sectionFor(PROFILE_PAGE_PATH)?.id).toBe('identity');
    expect(sectionFor(`${PROFILE_PAGE_PATH}/`)?.id).toBe('identity');
  });

  it('is a section on its own page and on anything beneath it', () => {
    expect(sectionFor(`${PROFILE_PAGE_PATH}/settings`)?.id).toBe('settings');
    expect(sectionFor(`${PROFILE_PAGE_PATH}/settings/`)?.id).toBe('settings');
    expect(sectionFor(`${PROFILE_PAGE_PATH}/settings/deeper`)?.id).toBe('settings');
  });

  it('is nothing for an address no section claims — a deferred destination is dropped, not guessed', () => {
    expect(sectionFor(`${PROFILE_PAGE_PATH}/questionnaires`)).toBeNull();
    expect(sectionFor(`${PROFILE_PAGE_PATH}/settingsx`)).toBeNull();
    expect(sectionFor('/recordings')).toBeNull();
  });
});
