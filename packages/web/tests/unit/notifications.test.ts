import { describe, expect, it } from 'vitest';
import {
  ANNOUNCEMENT_KINDS,
  DEFAULT_PLAYBACK_SPEED,
  NOTIFICATION_EXCERPT_LENGTH,
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_LABEL,
  ROLE,
  excerptForNotification,
  isAnnouncementKind,
  isNotificationKind,
  notificationReadPath,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { sendAnnouncementFor } from '@/server/notifications/service';

/**
 * **The notifications contract, and what a send refuses** ([3.17](docs/project/prd.md)).
 *
 * The refusals are asserted against the service with no server and no database: every one of
 * them is thrown by the parse before a statement is built, which is the property being pinned —
 * a malformed send never reaches the fan-out.
 */

const admin: Actor = {
  id: 'admin-1',
  email: 'admin@example.test',
  displayName: 'Admin',
  role: ROLE.admin,
  preferredPlaybackSpeed: DEFAULT_PLAYBACK_SPEED,
  avatarKey: null,
};

async function refusal(body: unknown): Promise<{ code: string; message: string }> {
  try {
    await sendAnnouncementFor(admin, body);
  } catch (caught) {
    if (caught instanceof ApiError) return { code: caught.code, message: caught.message };
    throw caught;
  }
  throw new Error('the send was not refused');
}

describe('the vocabulary', () => {
  it('names five kinds, two of which an admin composes, each with a label', () => {
    expect(NOTIFICATION_KINDS).toEqual([
      'recording_published',
      'note_reply',
      'note_reaction',
      'announcement',
      'new_feature',
    ]);
    expect(ANNOUNCEMENT_KINDS).toEqual(['announcement', 'new_feature']);
    for (const kind of NOTIFICATION_KINDS) {
      expect(NOTIFICATION_KIND_LABEL[kind]).toMatch(/\S/);
      expect(isNotificationKind(kind)).toBe(true);
    }
    expect(isAnnouncementKind('announcement')).toBe(true);
    expect(isAnnouncementKind('note_reply')).toBe(false);
    expect(isNotificationKind('email')).toBe(false);
  });

  it('builds the read path from the id', () => {
    expect(notificationReadPath('abc')).toBe('/notifications/abc/read');
  });
});

describe('the excerpt', () => {
  it('collapses whitespace and leaves a short note alone', () => {
    expect(excerptForNotification('  a   short\n\nnote ')).toBe('a short note');
  });

  it('cuts a long note at the ceiling with an ellipsis', () => {
    const long = 'word '.repeat(60);
    const cut = excerptForNotification(long);
    expect(cut.length).toBeLessThanOrEqual(NOTIFICATION_EXCERPT_LENGTH);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/\s…$/);
  });
});

describe('what a send refuses, before anything is written', () => {
  it('a body that is not an object, and a kind that is not one of the two', async () => {
    expect((await refusal(null)).code).toBe('invalid_input');
    expect((await refusal({ kind: 'note_reply', title: 'x', body: 'y' })).code).toBe(
      'invalid_input',
    );
  });

  it('a blank title, a blank body, and either over its ceiling', async () => {
    expect((await refusal({ kind: 'announcement', title: '  ', body: 'y' })).message).toBe(
      'Give it a title.',
    );
    expect((await refusal({ kind: 'announcement', title: 'x', body: '' })).message).toBe(
      'Write the message.',
    );
    expect(
      (await refusal({ kind: 'announcement', title: 'x'.repeat(121), body: 'y' })).message,
    ).toContain('120');
    expect(
      (await refusal({ kind: 'announcement', title: 'x', body: 'y'.repeat(1001) })).message,
    ).toContain('1,000');
  });

  it('a new feature with no onboarding, or with one the product does not have', async () => {
    expect((await refusal({ kind: 'new_feature', title: 'x', body: 'y' })).message).toContain(
      'needs the id',
    );
    expect(
      (await refusal({ kind: 'new_feature', title: 'x', body: 'y', onboardingId: 'no-such' }))
        .message,
    ).toContain('no-such');
  });

  it('an announcement that carries a link it is not allowed to have', async () => {
    expect(
      (await refusal({ kind: 'announcement', title: 'x', body: 'y', onboardingId: 'new-user' }))
        .message,
    ).toContain('no link');
  });
});
