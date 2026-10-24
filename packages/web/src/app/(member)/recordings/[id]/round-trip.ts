import { recordingPagePath } from '@thp/shared';

/**
 * **What survives the trip from the recording page to a chapter page and back** — which tab is
 * open, and how far down the chapter list was — and where each is kept while the member is away.
 *
 * Both screens keep their open tab in local state, so a return that was a fresh navigation of a
 * freshly mounted screen lost both: the tab fell back to `Notes` and the page landed at the top,
 * with the row the member had just pressed scrolled out of sight. The chapter page's back control
 * goes back *through history* (`back-route.tsx`), which brings the teaching's own entry back — and
 * two things kept on that entry make the return land where the member left:
 *
 * - **The open tab is in the address**, as `?tab=chapters`. It is written into the current history
 *   entry — never pushed — the moment a tab is pressed, so the entry the member comes back to names
 *   the tab they left open whether they return by the page's control or by the browser's. A reload
 *   keeps it and a copied link carries it. The bare address is `Notes`, so a direct link to a
 *   teaching opens where it always did.
 * - **The list's offset is on the history entry** (`history.state`), noted the moment a row is
 *   pressed. A history entry is the one thing that means *this visit and no other*: a fresh
 *   navigation to the same address — a link, the breadcrumb, the library — never sees it, so only a
 *   return lands down the list. `sessionStorage` would outlive the visit, and a link opened later in
 *   the same tab would find an offset it had no business restoring.
 *
 * The router keeps a page's own keys on an entry's state across its restores (it spreads the
 * entry's state back in), and everything written here goes through `replaceState` with *only* this
 * module's keys, so the router adds its own and — when an address is given — keeps
 * `useSearchParams` in step without a round trip to the server.
 */

const TAB_PARAM = 'tab';
const LIST_OFFSET_KEY = 'thpListOffset';

/** This module's keys on the current entry's state, and none of the router's. */
function ours(): Record<string, unknown> {
  const state: unknown = window.history.state;
  const kept: Record<string, unknown> = {};
  if (typeof state !== 'object' || state === null) return kept;
  if (LIST_OFFSET_KEY in state) kept[LIST_OFFSET_KEY] = (state as Record<string, unknown>)[LIST_OFFSET_KEY];
  return kept;
}

/** Rewrite the current entry: our keys plus `patch`, and the address when one is given. */
function writeEntry(patch: Record<string, unknown>, url?: string): void {
  window.history.replaceState({ ...ours(), ...patch }, '', url);
}

/** The tab the address names, or `null` when it names none, or one that `tabs` does not hold. */
export function tabFromAddress<T extends string>(
  params: { get(name: string): string | null },
  tabs: readonly T[],
): T | null {
  const named = params.get(TAB_PARAM);
  return tabs.find((tab) => tab === named) ?? null;
}

/**
 * Put the open tab into the address. The default tab and "all closed" are both the bare address:
 * the default because a link without the parameter has to keep meaning what it always meant, and
 * all-closed because it is a state a member reaches by a press, not one a link needs to express.
 */
export function writeTabToAddress(tab: string | null, defaultTab: string): void {
  const url = new URL(window.location.href);
  if (tab === null || tab === defaultTab) url.searchParams.delete(TAB_PARAM);
  else url.searchParams.set(TAB_PARAM, tab);
  writeEntry({}, url.toString());
}

/** The address of a teaching's page with one of its tabs open — the route back from a chapter. */
export function recordingTabHref(recordingId: string, tab: string): string {
  return `${recordingPagePath(recordingId)}?${TAB_PARAM}=${tab}`;
}

/**
 * Whether a press on a link is the plain one the page handles itself. A press with a modifier or
 * another button is the browser's — a new tab, a new window — and the page leaves it alone, which
 * is the line `next/link` draws for its own navigation.
 */
export function isPlainPress(event: {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly defaultPrevented: boolean;
}): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.defaultPrevented
  );
}

/** A chapter row is being pressed: note on this entry where the window is. */
export function leaveForChapter(): void {
  writeEntry({ [LIST_OFFSET_KEY]: window.scrollY });
}

/** The offset a row was pressed at on this very entry, or `null` on any other kind of visit. */
export function listOffsetLeftHere(): number | null {
  const offset = ours()[LIST_OFFSET_KEY];
  return typeof offset === 'number' && Number.isFinite(offset) ? offset : null;
}

/** The id a note's card carries wherever the notes panel draws it — the fragment that finds it. */
export function noteCardId(noteId: string): string {
  return `note-${noteId}`;
}

/**
 * The address of one note: the teaching's page with its Notes tab open, scrolled to the card.
 *
 * The fragment is the card's own id, so the browser's jump lands on it when the list is already in
 * the document, and the notes panel makes the same jump itself when the list arrives afterwards —
 * which is the case for every arrival from another screen, since the list is fetched on mount.
 */
export function noteHref(recordingId: string, noteId: string): string {
  return `${recordingTabHref(recordingId, 'notes')}#${noteCardId(noteId)}`;
}
