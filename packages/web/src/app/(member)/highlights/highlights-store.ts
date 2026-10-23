'use client';

import { useCallback, useSyncExternalStore } from 'react';
import {
  HIGHLIGHTS_PATH,
  highlightPath,
  type CreateHighlightRequest,
  type HighlightListPayload,
  type HighlightView,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';

/**
 * **The member's Highlights, held once per page load** ([3.15](docs/project/prd.md)) — what every
 * pin control and the playlist read, and what every pin and remove write back.
 *
 * **A module-level store rather than a provider**, and deliberately. Four surfaces show pinned
 * state — the transport's marker, the chapter page's, and the marker beside the `···` on every
 * note of one's own — and the recording page alone can mount dozens of them at once. A
 * hook that fetched per mount would be dozens of identical requests; a provider would mean editing
 * the member layout, which this ticket does not own and three other branches are changing. A
 * store that any number of hooks subscribe to is one fetch per page, no layout edit, and one
 * answer to "is this pinned" on every surface at once, because every write replaces the whole
 * list with what the API answered.
 *
 * **It fetches when the first subscriber arrives and again whenever the count returns from zero**
 * — which is a navigation to a new surface — and never on a timer. So a pin made on one screen is
 * on the next screen's first paint, and a page with fifty subscribers costs one request. A list
 * that fails to load is reported through `failure` and the controls render disabled rather than
 * guessing at pinned state; the next subscriber retries.
 *
 * Session state only: it lives as long as the document, and a sign-in as somebody else is a
 * navigation that reloads it. Nothing here is written to storage.
 */

export interface HighlightsSnapshot {
  /** The list as last answered, or `null` until the first fetch lands — or after it fails. */
  readonly highlights: readonly HighlightView[] | null;
  /** A write or the load in flight. Controls disable while it is, so two presses are one request. */
  readonly busy: boolean;
  readonly failure: string | null;
}

const LOAD_FAILED = 'Could not load your Highlights. Reload the page to try again.';
const WRITE_FAILED = 'Could not change your Highlights. Nothing has changed — try again in a moment.';

const EMPTY: HighlightsSnapshot = { highlights: null, busy: false, failure: null };

let snapshot: HighlightsSnapshot = EMPTY;
const listeners = new Set<() => void>();

function set(next: Partial<HighlightsSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

async function load(): Promise<void> {
  set({ busy: true, failure: null });
  try {
    const payload = await apiFetch<HighlightListPayload>(HIGHLIGHTS_PATH, {
      credentials: 'include',
    });
    set({ highlights: payload.highlights, busy: false });
  } catch {
    set({ highlights: null, busy: false, failure: LOAD_FAILED });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) void load();
  return () => {
    listeners.delete(listener);
  };
}

function read(): HighlightsSnapshot {
  return snapshot;
}

function readOnServer(): HighlightsSnapshot {
  return EMPTY;
}

function messageOf(caught: unknown): string {
  return caught instanceof ApiClientError ? caught.message : WRITE_FAILED;
}

/**
 * Pin, and hold what the API answered. Throws after recording the failure, so a control can
 * also react in place — the store's `failure` is for the surfaces that print one line for all.
 */
async function pin(request: CreateHighlightRequest): Promise<void> {
  set({ busy: true, failure: null });
  try {
    const payload = await apiFetch<HighlightListPayload>(HIGHLIGHTS_PATH, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    set({ highlights: payload.highlights, busy: false });
  } catch (caught) {
    set({ busy: false, failure: messageOf(caught) });
    throw caught;
  }
}

/** Remove, and hold what the API answered ([3.15.8](docs/project/prd.md)). */
async function unpin(highlightId: string): Promise<void> {
  set({ busy: true, failure: null });
  try {
    const payload = await apiFetch<HighlightListPayload>(highlightPath(highlightId), {
      method: 'DELETE',
      credentials: 'include',
    });
    set({ highlights: payload.highlights, busy: false });
  } catch (caught) {
    set({ busy: false, failure: messageOf(caught) });
    throw caught;
  }
}

export interface HighlightsApi extends HighlightsSnapshot {
  pin(request: CreateHighlightRequest): Promise<void>;
  unpin(highlightId: string): Promise<void>;
  /**
   * The one gesture every control makes: unpin the entry it is about, or pin what it would be.
   * Resolves without throwing — the failure is already on the store for the surface to print.
   */
  toggle(existing: HighlightView | null, request: CreateHighlightRequest): Promise<void>;
}

export function useHighlights(): HighlightsApi {
  const state = useSyncExternalStore(subscribe, read, readOnServer);
  const toggle = useCallback(async (existing: HighlightView | null, request: CreateHighlightRequest) => {
    try {
      if (existing === null) await pin(request);
      else await unpin(existing.id);
    } catch {
      // Recorded on the store; nothing more to do here.
    }
  }, []);
  return { ...state, pin, unpin, toggle };
}
