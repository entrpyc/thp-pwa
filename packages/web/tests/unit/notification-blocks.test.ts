import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAYBACK_SPEED, ROLE } from '@thp/shared';
import type { Actor } from '@/server/auth/policy';

/**
 * **A notice is not written across a block — at the notifications service itself.**
 *
 * Over the API this is unobservable on its own: the notes service refuses the reply or the
 * reaction before the notification is ever raised, so an integration test sees a refusal and an
 * unchanged centre and cannot tell which of the two gates was the one that held. This file holds
 * the second gate on its own, with the store faked, because it is the one a later caller — an
 * SOS reply, a push path — reaches without going through the notes service first.
 *
 * Every store function the two raisers touch is replaced: the predicate answers what the test
 * says, and the insert records whether it was asked.
 */

const isBlockedEitherWay = vi.fn<(a: string, b: string) => Promise<boolean>>();
const insertNotification = vi.fn();
const deleteReactionNotifications = vi.fn();

vi.mock('@thp/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@thp/db')>();
  return {
    ...original,
    isBlockedEitherWay,
    insertNotification,
    deleteReactionNotifications,
    withTransaction: (work: (tx: unknown) => Promise<unknown>) => work({}),
  };
});

const { notifyNoteReaction, notifyNoteReply } = await import('@/server/notifications/service');

const replier: Actor = {
  id: 'replier-1',
  email: 'replier@example.test',
  displayName: 'Replier',
  role: ROLE.member,
  preferredPlaybackSpeed: DEFAULT_PLAYBACK_SPEED,
  avatarKey: null,
  analyticsOptedOut: false,
  termsAcceptedVersion: null,
};

const input = {
  authorId: 'author-1',
  recordingId: 'recording-1',
  noteId: 'note-1',
};

beforeEach(() => {
  isBlockedEitherWay.mockReset();
  insertNotification.mockReset();
  deleteReactionNotifications.mockReset();
  insertNotification.mockResolvedValue({ id: 'notification-1' });
  deleteReactionNotifications.mockResolvedValue(0);
});

describe('a reply across a block', () => {
  it('asks the predicate about the pair and writes nothing when it answers true', async () => {
    isBlockedEitherWay.mockResolvedValue(true);

    await notifyNoteReply({ ...input, replier, replyText: 'hello' });

    expect(isBlockedEitherWay).toHaveBeenCalledWith('author-1', 'replier-1');
    expect(insertNotification).not.toHaveBeenCalled();
  });

  it('writes the notice when the pair has no block', async () => {
    isBlockedEitherWay.mockResolvedValue(false);

    await notifyNoteReply({ ...input, replier, replyText: 'hello' });

    expect(insertNotification).toHaveBeenCalledTimes(1);
    expect(insertNotification.mock.calls[0]?.[0]).toBe('author-1');
  });

  it('does not ask at all when the author answers themselves — there is no pair', async () => {
    await notifyNoteReply({ ...input, authorId: replier.id, replier, replyText: 'hello' });
    expect(isBlockedEitherWay).not.toHaveBeenCalled();
    expect(insertNotification).not.toHaveBeenCalled();
  });
});

describe('a reaction across a block', () => {
  it('writes nothing and takes nothing away when the pair is blocked', async () => {
    isBlockedEitherWay.mockResolvedValue(true);

    await notifyNoteReaction({ ...input, reactor: replier, noteText: 'a thought' });

    expect(isBlockedEitherWay).toHaveBeenCalledWith('author-1', 'replier-1');
    expect(deleteReactionNotifications).not.toHaveBeenCalled();
    expect(insertNotification).not.toHaveBeenCalled();
  });

  it('replaces the earlier notice as before when the pair has no block', async () => {
    isBlockedEitherWay.mockResolvedValue(false);

    await notifyNoteReaction({ ...input, reactor: replier, noteText: 'a thought' });

    expect(deleteReactionNotifications).toHaveBeenCalledTimes(1);
    expect(insertNotification).toHaveBeenCalledTimes(1);
  });
});
