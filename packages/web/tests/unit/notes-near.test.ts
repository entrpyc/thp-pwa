import { describe, expect, it } from 'vitest';
import type { NoteView } from '@thp/shared';
import {
  NOTE_LINGER_MS,
  NOTE_LOOKAHEAD_MS,
  notesNear,
} from '@/app/(member)/now-playing/notes-near';

/**
 * **The window the now-playing view reads notes through.**
 *
 * Pinned as arithmetic: it looks two minutes ahead and two minutes back, both edges inclusive; it
 * lists soonest first; and it leaves out what has no moment of its own (a reply) or nothing to
 * read (a tombstone).
 */
function note(overrides: Partial<NoteView> & { id: string }): NoteView {
  return {
    timestampMs: 0,
    authorId: 'a',
    authorDisplayName: 'A',
    authorAvatarUrl: null,
    visibility: 'public',
    mine: false,
    text: 'text',
    createdAt: '2026-08-16T00:00:00.000Z',
    deleted: false,
    pinned: false,
    replies: [],
    reactions: [],
    myReaction: null,
    images: [],
    ...overrides,
  };
}

describe('notesNear', () => {
  it('looks two minutes ahead and two minutes back, edges included', () => {
    const notes = [
      note({ id: 'just-ahead', timestampMs: 60_000 + NOTE_LOOKAHEAD_MS }),
      note({ id: 'too-far-ahead', timestampMs: 60_000 + NOTE_LOOKAHEAD_MS + 1 }),
      note({ id: 'just-past', timestampMs: 60_000 - NOTE_LINGER_MS }),
      note({ id: 'too-long-past', timestampMs: 60_000 - NOTE_LINGER_MS - 1 }),
      note({ id: 'now', timestampMs: 60_000 }),
    ];
    expect(notesNear(notes, 60_000).map((one) => one.id)).toEqual(['just-past', 'now', 'just-ahead']);
  });

  it('lists soonest first whatever order the notes arrived in', () => {
    const notes = [
      note({ id: 'c', timestampMs: 30_000 }),
      note({ id: 'a', timestampMs: 10_000 }),
      note({ id: 'b', timestampMs: 20_000 }),
    ];
    expect(notesNear(notes, 0).map((one) => one.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves out tombstones and notes with no moment of their own', () => {
    const notes = [
      note({ id: 'gone', timestampMs: 5_000, deleted: true, text: '' }),
      note({ id: 'reply', timestampMs: null }),
      note({ id: 'kept', timestampMs: 5_000 }),
    ];
    expect(notesNear(notes, 0).map((one) => one.id)).toEqual(['kept']);
  });

  it('answers an empty list when nothing is near', () => {
    expect(notesNear([note({ id: 'late', timestampMs: 300_000 })], 0)).toEqual([]);
    expect(notesNear([note({ id: 'long-gone', timestampMs: 0 })], 300_000)).toEqual([]);
    expect(notesNear([], 0)).toEqual([]);
  });
});
