import type { NoteView } from '@thp/shared';

/**
 * How far either side of the playhead a timestamped item is shown on the now-playing view.
 *
 * The window is **symmetrical**: two minutes ahead, so a note is read before the voice reaches its
 * moment, and two minutes behind, so a member who looks down after hearing something said still
 * finds what was written about it. A shorter tail turned the row over faster, and turned it over
 * before anyone had finished reading.
 */
export const NOTE_LOOKAHEAD_MS = 120_000;
export const NOTE_LINGER_MS = 120_000;

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
