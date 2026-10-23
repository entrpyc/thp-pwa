import { describe, expect, it } from 'vitest';
import {
  ADMIN_ONLY_CATEGORIES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_DESCRIPTION,
  NOTIFICATION_CATEGORY_LABEL,
  NOTIFICATION_CATEGORY_OF_KIND,
  NOTIFICATION_KINDS,
  categoriesVisibleTo,
  isNotificationCategory,
  isPushAllowed,
  isPushPlatform,
} from '@thp/shared';
import { applicationServerKey } from '@/client/push/push-device';

/**
 * **The preference rule** ([3.17.13](docs/project/prd.md), [3.17.14](docs/project/prd.md)), on
 * its own: push is allowed unless the kind's category is switched off, every kind has a category,
 * announcements are as mutable as anything else, and a member is never offered the admin-only
 * switch. The query that applies the same rule at scale is held to this sentence by
 * `push.test.ts`.
 */
describe('the preference rule', () => {
  it('allows every kind when nothing has been set — on by default', () => {
    for (const kind of NOTIFICATION_KINDS) expect(isPushAllowed(kind, {})).toBe(true);
  });

  it('silences exactly the kinds of a category switched off', () => {
    expect(isPushAllowed('note_reply', { notes: false })).toBe(false);
    expect(isPushAllowed('note_reaction', { notes: false })).toBe(false);
    expect(isPushAllowed('report_resolved', { notes: false })).toBe(false);
    expect(isPushAllowed('recording_published', { notes: false })).toBe(true);
    expect(isPushAllowed('announcement', { notes: false })).toBe(true);
  });

  it('lets a member mute the admins and the product alike (3.17.14)', () => {
    expect(isPushAllowed('announcement', { announcements: false })).toBe(false);
    expect(isPushAllowed('new_feature', { announcements: false })).toBe(false);
  });

  it('reads a category set back to true as on', () => {
    expect(isPushAllowed('recording_published', { recordings: true })).toBe(true);
  });
});

describe('the categories', () => {
  it('cover every kind, each with a label and a sentence', () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(isNotificationCategory(NOTIFICATION_CATEGORY_OF_KIND[kind])).toBe(true);
    }
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(NOTIFICATION_CATEGORY_LABEL[category]).toMatch(/\S/);
      expect(NOTIFICATION_CATEGORY_DESCRIPTION[category]).toMatch(/\S/);
    }
  });

  it('put what only admins receive in the admin-only category, and nothing else there', () => {
    expect(NOTIFICATION_CATEGORY_OF_KIND.summary_ready).toBe('admin_alerts');
    expect(NOTIFICATION_CATEGORY_OF_KIND.note_reported).toBe('admin_alerts');
    const adminKinds = NOTIFICATION_KINDS.filter((kind) => NOTIFICATION_CATEGORY_OF_KIND[kind] === 'admin_alerts');
    expect(adminKinds.sort()).toEqual(['note_reported', 'summary_ready']);
  });

  it('are offered without the admin-only one unless the policy says so, in the declared order', () => {
    expect(categoriesVisibleTo(false)).toEqual(['recordings', 'notes', 'announcements', 'sos']);
    expect(categoriesVisibleTo(true)).toEqual([...NOTIFICATION_CATEGORIES]);
    expect(ADMIN_ONLY_CATEGORIES).toEqual(['admin_alerts']);
  });

  it('name three platforms and refuse a fourth', () => {
    expect(isPushPlatform('web')).toBe(true);
    expect(isPushPlatform('ios')).toBe(true);
    expect(isPushPlatform('android')).toBe(true);
    expect(isPushPlatform('windows')).toBe(false);
    expect(isNotificationCategory('videos')).toBe(false);
  });
});

describe('the VAPID key a browser subscribes with', () => {
  it('is decoded from base64url to the bytes the push manager wants', () => {
    // "hello" in base64url is aGVsbG8 — no padding, which is how web-push prints keys.
    expect(Array.from(applicationServerKey('aGVsbG8'))).toEqual([104, 101, 108, 108, 111]);
    expect(Array.from(applicationServerKey('-_8'))).toEqual([251, 255]);
  });
});
