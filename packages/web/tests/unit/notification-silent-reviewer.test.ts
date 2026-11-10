import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAYBACK_SPEED, ROLE, SILENT_NOTIFIER_EMAILS, isSilentNotifier } from '@thp/shared';
import type { Actor } from '@/server/auth/policy';

/**
 * **The reviewer account raises no notice for anybody.** Every raiser whose cause is a member's
 * act — a reply, a reaction, a report, a prayer request — returns before the store is asked
 * anything, so a review pass through the product rings nobody's bell and reaches nobody's device.
 */

const isBlockedEitherWay = vi.fn<(a: string, b: string) => Promise<boolean>>();
const insertNotification = vi.fn();
const insertNotificationForSosAudience = vi.fn();
const deleteReactionNotifications = vi.fn();
const listActiveAdminIds = vi.fn();
const deliverPush = vi.fn();

vi.mock('@thp/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@thp/db')>();
  return {
    ...original,
    isBlockedEitherWay,
    insertNotification,
    insertNotificationForSosAudience,
    deleteReactionNotifications,
    listActiveAdminIds,
    withTransaction: (work: (tx: unknown) => Promise<unknown>) => work({}),
  };
});

vi.mock('@thp/push', () => ({ deliverPush }));

const {
  notifyNoteReaction,
  notifyNoteReply,
  notifyNoteReported,
  notifySosRaised,
  notifySosReply,
  notifySosReported,
  notifySosThreadReply,
} = await import('@/server/notifications/service');

function actor(email: string, id = 'actor-1'): Actor {
  return {
    id,
    email,
    displayName: 'Someone',
    role: ROLE.member,
    preferredPlaybackSpeed: DEFAULT_PLAYBACK_SPEED,
    avatarKey: null,
    analyticsOptedOut: false,
    termsAcceptedVersion: null,
  };
}

const reviewer = actor(SILENT_NOTIFIER_EMAILS[0]!);
const member = actor('member@example.test');

beforeEach(() => {
  vi.resetAllMocks();
  isBlockedEitherWay.mockResolvedValue(false);
  insertNotification.mockResolvedValue({ id: 'notification-1' });
  insertNotificationForSosAudience.mockResolvedValue(['notification-1']);
  deleteReactionNotifications.mockResolvedValue(0);
  listActiveAdminIds.mockResolvedValue(['admin-1']);
  deliverPush.mockResolvedValue(undefined);
});

describe('isSilentNotifier', () => {
  it('matches the reviewer address regardless of case or surrounding space', () => {
    expect(isSilentNotifier('asen.angelov+review@indepthwebsolutions.com')).toBe(true);
    expect(isSilentNotifier('  Asen.Angelov+Review@IndepthWebSolutions.com ')).toBe(true);
  });

  it('does not match anybody else', () => {
    expect(isSilentNotifier('asen.angelov@indepthwebsolutions.com')).toBe(false);
    expect(isSilentNotifier('member@example.test')).toBe(false);
  });
});

const cases: readonly [string, (who: Actor) => Promise<void>][] = [
  [
    'a note reply',
    (who) =>
      notifyNoteReply({
        authorId: 'author-1',
        recordingId: 'recording-1',
        noteId: 'note-1',
        replier: who,
        replyText: 'hello',
      }),
  ],
  [
    'a note reaction',
    (who) =>
      notifyNoteReaction({
        authorId: 'author-1',
        recordingId: 'recording-1',
        noteId: 'note-1',
        reactor: who,
        noteText: 'hello',
      }),
  ],
  [
    'a note report',
    (who) =>
      notifyNoteReported({
        reportId: 'report-1',
        noteId: 'note-1',
        recordingId: 'recording-1',
        reason: 'spam',
        noteText: 'hello',
        reporter: who,
      }),
  ],
  [
    'a prayer request',
    (who) =>
      notifySosRaised({
        signalId: 'signal-1',
        urgency: 'yellow',
        description: 'please pray',
        author: who,
        anonymous: false,
      }),
  ],
  [
    'a prayer request reply',
    (who) =>
      notifySosReply({ signalId: 'signal-1', authorId: 'author-1', replier: who, replyText: 'hi' }),
  ],
  [
    'a reply inside a prayer thread',
    (who) =>
      notifySosThreadReply({
        signalId: 'signal-1',
        signalAuthorId: 'author-1',
        signalAnonymous: false,
        threadAuthorId: 'thread-author-1',
        replier: who,
        replyText: 'hi',
      }),
  ],
  [
    'a prayer request report',
    (who) =>
      notifySosReported({
        reportId: 'report-1',
        signalId: 'signal-1',
        replyId: null,
        reason: 'spam',
        text: 'hello',
        reporter: who,
      }),
  ],
];

describe.each(cases)('%s by the reviewer account', (_name, act) => {
  it('writes nothing and pushes nothing', async () => {
    await act(reviewer);

    expect(insertNotification).not.toHaveBeenCalled();
    expect(insertNotificationForSosAudience).not.toHaveBeenCalled();
    expect(isBlockedEitherWay).not.toHaveBeenCalled();
    expect(listActiveAdminIds).not.toHaveBeenCalled();
    expect(deliverPush).not.toHaveBeenCalled();
  });

  it('still writes and pushes for an ordinary member', async () => {
    await act(member);

    expect(
      insertNotification.mock.calls.length + insertNotificationForSosAudience.mock.calls.length,
    ).toBeGreaterThan(0);
    expect(deliverPush).toHaveBeenCalledTimes(1);
  });
});
