import { NOTE_VISIBILITIES, type NoteVisibility } from '@thp/shared';

/**
 * **A note that is being written, kept where a closed tab cannot take it.**
 *
 * A member types a paragraph about the sentence they have just heard, switches to look something up
 * and comes back to an empty box. Nothing about that is a failure the product reports — the note was
 * never sent anywhere — which is exactly why it has to be the composer's job rather than the API's.
 *
 * **Local storage.** A tab change, a navigation, a reload and the browser being closed altogether:
 * the draft outlives all four, which is what makes it a rescue rather than a convenience. Session
 * storage would have covered the first three and lost the note to exactly the case a member is
 * least able to recover from — a phone that killed the tab overnight.
 *
 * Two consequences that follow from the choice rather than working against it. It is **shared
 * between tabs** on this device, so one teaching has one draft however many windows are open, which
 * is the same rule the two composer mounts already follow. And a draft can come back **days later**:
 * that is why saving clears it, why an emptied box clears it, and why the moment it was anchored to
 * is stored beside it — a paragraph returning without its moment would be worse than one lost.
 *
 * It is **per device, never synced**, and it never reaches the server. An unsaved note is not a note
 * yet; nothing in the product knows about it until the member presses save.
 *
 * **The moment travels with the text.** A note is a paragraph *and* the second it is about
 * ([3.1.1](docs/project/prd.md)), and the anchor is frozen at the first keystroke — so restoring the
 * words without the moment would quietly re-anchor the note to wherever playback had reached by the
 * time the member came back. That is a wrong note rather than a lost one, which is worse.
 *
 * Everything here is **guarded**: a browser with storage disabled, a private window that throws on
 * write, or a quota that is full must cost the member nothing more than the behaviour they had
 * before this existed. Every failure is swallowed and the composer carries on.
 */

export interface NoteDraft {
  readonly text: string;
  readonly visibility: NoteVisibility;
  /** The moment the note is anchored to, in milliseconds from the start of the teaching. */
  readonly anchorMs: number;
}

/**
 * One draft per teaching, namespaced so nothing else in the origin's local storage collides with
 * it. Per *recording* rather than per composer: the inline panel and the transport's sheet are two
 * mounts of one composer writing one note, and a key each would make them two different notes.
 */
export function noteDraftKey(recordingId: string): string {
  return `thp:note-draft:${recordingId}`;
}

function storage(): Storage | null {
  try {
    // Absent during rendering on the server, and an access that *throws* rather than returning
    // undefined in a browser configured to block site data.
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The draft for this teaching, or `null` — which covers every way there can fail to be one: nothing
 * stored, storage unreachable, and **anything stored that is not a draft**.
 *
 * The shape is checked rather than trusted. What comes back is a string this origin wrote, but it
 * may have been written by an older version of this code, and a `visibility` that is neither of the
 * two values would otherwise reach the API as a refusal a member cannot explain.
 */
export function readNoteDraft(recordingId: string): NoteDraft | null {
  const store = storage();
  if (store === null) return null;

  let raw: string | null;
  try {
    raw = store.getItem(noteDraftKey(recordingId));
  } catch {
    return null;
  }
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { text, visibility, anchorMs } = parsed as Partial<NoteDraft>;
    if (typeof text !== 'string' || text.trim() === '') return null;
    const kept = NOTE_VISIBILITIES.find((allowed) => allowed === visibility);
    if (kept === undefined) return null;
    if (typeof anchorMs !== 'number' || !Number.isFinite(anchorMs) || anchorMs < 0) return null;
    return { text, visibility: kept, anchorMs };
  } catch {
    return null;
  }
}

/**
 * Keep this teaching's draft, or **clear it when there is nothing left to keep**.
 *
 * Empty is a deletion rather than an empty draft: a member who has cleared the box has no note in
 * progress, and a stored blank would reopen the composer holding nothing while claiming to hold
 * something. Trimmed, for the same reason the composer counts trimmed — whitespace is not a note.
 */
export function writeNoteDraft(recordingId: string, draft: NoteDraft): void {
  const store = storage();
  if (store === null) return;

  try {
    if (draft.text.trim() === '') {
      store.removeItem(noteDraftKey(recordingId));
      return;
    }
    store.setItem(noteDraftKey(recordingId), JSON.stringify(draft));
  } catch {
    // A full quota costs the draft, not the note being written — the composer still holds the text.
  }
}

/** Drop this teaching's draft. Called when the note it held has been saved. */
export function clearNoteDraft(recordingId: string): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(noteDraftKey(recordingId));
  } catch {
    // Nothing to do and nothing to say: the draft outliving its note is a stale box, not a failure.
  }
}
