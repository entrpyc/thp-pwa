import type { NoteView } from '@thp/shared';

/**
 * How far ahead of the playhead a note is shown, and how long it stays once its moment has passed.
 *
 * The window **looks forward**: a note on the now-playing view is a heads-up about what is coming
 * rather than a record of what was said. Two minutes ahead is long enough to read it before the
 * voice reaches the moment; a quarter of a minute after is long enough to see that the moment has
 * arrived and no longer, so the row keeps turning over as the teaching plays rather than filling up
 * behind it.
 */
export const NOTE_LOOKAHEAD_MS = 120_000;
export const NOTE_LINGER_MS = 15_000;

/**
 * The notes anchored near `nowMs`, soonest first.
 *
 * Tombstones and replies are left out: a tombstone has nothing to read and a reply has no moment of
 * its own (its `timestampMs` is `null` — it belongs to its parent's). The set it filters is the
 * player's, which is the set the transport's markers and the recording page's list already share.
 */
export function notesNear(notes: readonly NoteView[], nowMs: number): NoteView[] {
  return notes
    .filter(
      (note): note is NoteView & { timestampMs: number } =>
        !note.deleted &&
        note.timestampMs !== null &&
        note.timestampMs - NOTE_LOOKAHEAD_MS <= nowMs &&
        nowMs <= note.timestampMs + NOTE_LINGER_MS,
    )
    .sort((a, b) => a.timestampMs - b.timestampMs);
}
