import type { SeriesDownloadItem } from '@thp/shared';

/**
 * **The download queue, as a value** ([3.18.7](docs/project/prd.md), [3.18.8](docs/project/prd.md),
 * [3.18.17](docs/project/prd.md); project tdd 5.8).
 *
 * Pure functions over a plain state, in the manner of `playback/cadence.ts`: what the manager does
 * is wire these to a store and a fetch, and what a test can hold them to needs no browser. Two
 * things are decided here and nowhere else — the order items run in and what the two progress
 * figures mean — and one more that the PRD spells out at length: whether a "Download all" is
 * refused before it starts, and which recordings are offered instead.
 */

export type QueueItemStatus = 'queued' | 'downloading' | 'done' | 'failed' | 'cancelled';

export interface QueueItem {
  readonly recordingId: string;
  readonly title: string;
  /** What the grant said the object is; the denominator of this item's progress. */
  readonly bytes: number;
  readonly loaded: number;
  readonly status: QueueItemStatus;
  /** The sentence to show when `status` is `failed`. */
  readonly failure: string | null;
}

export interface QueueState {
  /** In the order they were asked for, which is the order they run in. */
  readonly items: readonly QueueItem[];
}

export const EMPTY_QUEUE: QueueState = { items: [] };

/** Whether an item is still ahead of the member — waiting or transferring. */
export function isLive(item: QueueItem): boolean {
  return item.status === 'queued' || item.status === 'downloading';
}

/**
 * Add to the back. A recording already live in the queue is not added again — pressing the
 * control twice is one download — and one that finished, failed or was cancelled earlier is
 * replaced by a fresh entry, because a retry is a new attempt and its old progress is not news.
 */
export function enqueue(
  state: QueueState,
  item: Pick<QueueItem, 'recordingId' | 'title' | 'bytes'>,
): QueueState {
  if (state.items.some((one) => one.recordingId === item.recordingId && isLive(one))) return state;
  const fresh: QueueItem = { ...item, loaded: 0, status: 'queued', failure: null };
  return {
    items: [...state.items.filter((one) => one.recordingId !== item.recordingId), fresh],
  };
}

/** The item to run next, or `null`. One at a time: a phone has one radio and one disk. */
export function nextQueued(state: QueueState): QueueItem | null {
  if (state.items.some((one) => one.status === 'downloading')) return null;
  return state.items.find((one) => one.status === 'queued') ?? null;
}

function patch(
  state: QueueState,
  recordingId: string,
  change: (item: QueueItem) => QueueItem,
): QueueState {
  return {
    items: state.items.map((one) => (one.recordingId === recordingId ? change(one) : one)),
  };
}

export function start(state: QueueState, recordingId: string, bytes?: number): QueueState {
  return patch(state, recordingId, (item) => ({
    ...item,
    status: 'downloading',
    loaded: 0,
    ...(bytes === undefined ? {} : { bytes }),
  }));
}

export function progress(state: QueueState, recordingId: string, loaded: number): QueueState {
  // Not clamped to `bytes`: a transfer that runs past what the grant said is still a true count,
  // and `itemFraction` is where the bar is held to one.
  return patch(state, recordingId, (item) =>
    item.status === 'downloading' ? { ...item, loaded: Math.max(0, loaded) } : item,
  );
}

export function finish(state: QueueState, recordingId: string): QueueState {
  return patch(state, recordingId, (item) => ({ ...item, status: 'done', loaded: item.bytes }));
}

export function fail(state: QueueState, recordingId: string, failure: string): QueueState {
  return patch(state, recordingId, (item) => ({ ...item, status: 'failed', failure }));
}

/** Cancel a live item. A queued one simply leaves; a transferring one is marked and its fetch aborted by the manager. */
export function cancel(state: QueueState, recordingId: string): QueueState {
  return patch(state, recordingId, (item) => (isLive(item) ? { ...item, status: 'cancelled' } : item));
}

/** Drop everything that is no longer live, so a long session's list does not grow without bound. */
export function prune(state: QueueState): QueueState {
  return { items: state.items.filter(isLive) };
}

/** What a single item's bar shows: a fraction in `[0, 1]`. `0` while nothing is known. */
export function itemFraction(item: QueueItem): number {
  if (item.status === 'done') return 1;
  if (item.bytes <= 0) return 0;
  return Math.min(1, item.loaded / item.bytes);
}

export interface OverallProgress {
  /** How many items are still live. */
  readonly remaining: number;
  /** Bytes transferred so far across every live item. */
  readonly loaded: number;
  /** Bytes the live items add up to. */
  readonly total: number;
  /** `loaded / total`, or `0` when nothing is live. */
  readonly fraction: number;
}

/**
 * The overall figure ([3.18.8](docs/project/prd.md)): over the **live** items only. A finished
 * download leaves the figure rather than pinning it near the top for the rest of the queue —
 * "three left, 40%" is what a member wants to know, not "of the eleven you asked for an hour ago".
 */
export function overall(state: QueueState): OverallProgress {
  const live = state.items.filter(isLive);
  const total = live.reduce((sum, one) => sum + one.bytes, 0);
  const loaded = live.reduce((sum, one) => sum + Math.min(one.loaded, one.bytes), 0);
  return {
    remaining: live.length,
    loaded,
    total,
    fraction: total > 0 ? loaded / total : 0,
  };
}

// =================================================================================================
// "Download all", before the queue is built (3.18.17; tdd 5.8)
// =================================================================================================

/**
 * What the browser keeps back from a download, beyond the bytes themselves.
 *
 * A download that fills the device to its last byte leaves nothing for the page cache, the
 * outbox, or the browser's own bookkeeping — and a browser at its quota starts evicting, which is
 * the failure the check exists to prevent. A flat reserve rather than a percentage because the
 * things it protects are small and fixed; on a 32 GB phone and on a desktop alike, sixty-four
 * megabytes is a few pages and a few thousand notes.
 */
export const FREE_SPACE_RESERVE_BYTES = 64 * 1024 * 1024;

export interface SeriesPlanInput {
  /** The series' recordings with their sizes, newest recorded first — the route's own order. */
  readonly recordings: readonly SeriesDownloadItem[];
  /** Ids already downloaded or live in the queue, which cost nothing more. */
  readonly held: ReadonlySet<string>;
  /** What the device reports free, or `null` where the check does not apply (a store build). */
  readonly freeBytes: number | null;
}

export interface SeriesPlan {
  /** The recordings that would actually be fetched: not already held. */
  readonly wanted: readonly SeriesDownloadItem[];
  /** What they add up to — "what the series needs". */
  readonly neededBytes: number;
  /** What the device has, after the reserve — "what is available". `null` where not subject. */
  readonly availableBytes: number | null;
  /** Whether the whole of `wanted` fits. Always `true` where the check does not apply. */
  readonly fits: boolean;
  /**
   * The offer when it does not fit: the **most recent** recordings that do, as a prefix of the
   * newest-first list. Empty when not even the newest one fits. Equal to `wanted` when it fits.
   */
  readonly offered: readonly SeriesDownloadItem[];
}

/**
 * Decide, before anything is fetched, whether a series fits — and if not, what to offer instead.
 *
 * "Most recent" is the series' own order rather than a re-sort: the route answers newest recorded
 * first, which is the one answer the product has to "what is most recent" (3.3.1). The offer is a
 * prefix of that order, taken greedily — the newest, then the next, until the next would not fit.
 * A greedy prefix rather than the best-packing subset, because the member was promised the
 * *recent* ones, not the most bytes.
 */
export function planSeriesDownload(input: SeriesPlanInput): SeriesPlan {
  const wanted = input.recordings.filter((one) => !input.held.has(one.id));
  const neededBytes = wanted.reduce((sum, one) => sum + one.bytes, 0);

  if (input.freeBytes === null) {
    return { wanted, neededBytes, availableBytes: null, fits: true, offered: wanted };
  }

  const availableBytes = Math.max(0, input.freeBytes - FREE_SPACE_RESERVE_BYTES);
  if (neededBytes <= availableBytes) {
    return { wanted, neededBytes, availableBytes, fits: true, offered: wanted };
  }

  const offered: SeriesDownloadItem[] = [];
  let running = 0;
  for (const one of wanted) {
    if (running + one.bytes > availableBytes) break;
    running += one.bytes;
    offered.push(one);
  }
  return { wanted, neededBytes, availableBytes, fits: false, offered };
}

/** The single-recording form of the same check (3.18.17's first sentence). */
export function fitsAlone(bytes: number, freeBytes: number | null): boolean {
  if (freeBytes === null) return true;
  return bytes <= Math.max(0, freeBytes - FREE_SPACE_RESERVE_BYTES);
}
