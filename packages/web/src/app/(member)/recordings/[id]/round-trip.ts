import { recordingPagePath } from '@thp/shared';

/**
 * **What survives the trip from the recording page to a chapter page and back** — which tab is
 * open, and how far down the chapter list was — and where each is kept while the member is away.
 *
 * Both screens keep their open tab in local state, and the chapter page's back control is an
 * address rather than a `history.back()` (see `chapter-view.tsx`: a member who arrived from a link
 * has nothing to go back *to*). Those two facts together made every return a fresh navigation of a
 * freshly mounted screen: the tab fell back to `Notes` and the page landed at the top, with the row
 * the member had just pressed scrolled out of sight. Three things put that right, and each is kept
 * in the one place whose lifetime is exactly the right one:
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
 * - **The chapter page is told it was reached from the list**, so its back control can go back
 *   *through history* — which is what brings that entry back, offset and all — instead of
 *   navigating to a fresh one. The telling goes through `sessionStorage`, because nothing can write
 *   to a history entry before it exists; the chapter page takes it on arrival and stamps the fact
 *   onto its own entry, where going forward and back to that chapter still finds it. A chapter
 *   opened from a link finds nothing and keeps the address it always had — the teaching, now with
 *   its chapter list open, which is the list this chapter is a row of.
 *
 * The router keeps a page's own keys on an entry's state across its restores (it spreads the
 * entry's state back in), and everything written here goes through `replaceState` with *only* this
 * module's keys, so the router adds its own and — when an address is given — keeps
 * `useSearchParams` in step without a round trip to the server. Those keys are the whole of what
 * the two pages pass to each other.
 */

const TAB_PARAM = 'tab';
const LIST_OFFSET_KEY = 'thpListOffset';
const FROM_LIST_KEY = 'thpFromList';
/** The hand-over to a chapter page about to mount: `{ recordingId, chapterId }`. */
const HANDOFF_KEY = 'thp.chapter-from-list';

/** This module's keys on the current entry's state, and none of the router's. */
function ours(): Record<string, unknown> {
  const state: unknown = window.history.state;
  const kept: Record<string, unknown> = {};
  if (typeof state !== 'object' || state === null) return kept;
  for (const key of [LIST_OFFSET_KEY, FROM_LIST_KEY]) {
    if (key in state) kept[key] = (state as Record<string, unknown>)[key];
  }
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

/**
 * A chapter row is being pressed: note on this entry where the window is, and tell the chapter
 * page about to mount that it was reached from the list.
 */
export function leaveForChapter(recordingId: string, chapterId: string): void {
  writeEntry({ [LIST_OFFSET_KEY]: window.scrollY });
  try {
    window.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ recordingId, chapterId }));
  } catch {
    // Storage refused — a private window, a full quota. The chapter page's back control then
    // navigates rather than going back: the same place, reached at the top of the list.
  }
}

/** The offset a row was pressed at on this very entry, or `null` on any other kind of visit. */
export function listOffsetLeftHere(): number | null {
  const offset = ours()[LIST_OFFSET_KEY];
  return typeof offset === 'number' && Number.isFinite(offset) ? offset : null;
}

/**
 * Whether this chapter page is the entry after its teaching's, reached by a row on the list — and
 * so whether going back through history is the way back to it.
 *
 * Read once, on arrival. The hand-over is taken as it is read, so a stale one cannot describe a
 * later visit, and the answer is stamped onto this entry so a member who goes forward and back to
 * this chapter gets the same back control they had the first time.
 */
export function arrivedFromList(recordingId: string, chapterId: string): boolean {
  if (ours()[FROM_LIST_KEY] === true) return true;

  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(HANDOFF_KEY);
    if (raw !== null) window.sessionStorage.removeItem(HANDOFF_KEY);
  } catch {
    return false;
  }
  if (raw === null) return false;

  let handoff: unknown;
  try {
    handoff = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof handoff !== 'object' || handoff === null) return false;
  const { recordingId: fromRecording, chapterId: toChapter } = handoff as Record<string, unknown>;
  if (fromRecording !== recordingId || toChapter !== chapterId) return false;

  writeEntry({ [FROM_LIST_KEY]: true });
  return true;
}
