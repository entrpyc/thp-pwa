import { HIGHLIGHT_AT_PARAM, HIGHLIGHT_NOTE_PARAM, recordingPagePath } from '@thp/shared';

/**
 * **Opening a teaching at a highlight's moment** ([3.15.7](docs/project/prd.md)), without sound
 * ([3.2.12](docs/project/prd.md)).
 *
 * The playlist row links to `/recordings/{id}?at=<ms>`, and the recording page reads the parameter
 * at mount and hands it to the player in place of the stored position. Read off the document's
 * own address rather than through `useSearchParams`, so the one line the recording page changes
 * stays inside the effect it already has, with no new dependency to list; the page mounts once per
 * address, which is the one moment the parameter means anything. Nothing writes it back: the
 * address a bookmark holds keeps meaning the same moment.
 */

/**
 * The row's address: the teaching, at the entry's moment — or just the teaching, for a whole one.
 * A note entry also names its note, so the Notes tab can scroll to the card the member pressed.
 */
export function highlightHref(
  recordingId: string,
  positionMs: number | null,
  noteId: string | null = null,
): string {
  const path = recordingPagePath(recordingId);
  const params = new URLSearchParams();
  if (positionMs !== null) params.set(HIGHLIGHT_AT_PARAM, String(positionMs));
  if (noteId !== null) params.set(HIGHLIGHT_NOTE_PARAM, noteId);
  const query = params.toString();
  return query === '' ? path : `${path}?${query}`;
}

/**
 * The note the current address asks the Notes tab to scroll to, or `null` when it names none —
 * including on the server. Only the id's shape is checked here; whether the note is in the list
 * is the panel's to find out.
 */
export function noteFromAddress(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get(HIGHLIGHT_NOTE_PARAM);
  if (raw === null || !/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return null;
  return raw;
}

/**
 * The moment the current address asks the page to open at, or `null` when it asks nothing —
 * including on the server, where there is no address to read, and for a value that is not a
 * whole non-negative number of milliseconds, which is a bookmark somebody edited by hand.
 */
export function openAtFromAddress(): number | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get(HIGHLIGHT_AT_PARAM);
  if (raw === null || !/^\d{1,12}$/.test(raw)) return null;
  return Number(raw);
}
