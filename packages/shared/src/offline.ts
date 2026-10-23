import type { ApiErrorCode } from './api';
import { PROFILE_PAGE_PATH } from './accounts';
import type { CreateNoteRequest, NoteView } from './notes';
import type { PlaybackProgressRequest } from './playback';
import { RECORDINGS_PATH } from './recordings';
import { SERIES_PATH } from './series';

/**
 * **Offline support and downloads** ([3.18](docs/project/prd.md); project tdd 2.1, 5.2, 5.3, 5.8)
 * — the wire contract between the client's download store and outbox and the three routes that
 * serve them.
 *
 * Three routes, and why three rather than one:
 *
 * - **A download grant** (`GET /recordings/:id/download`) is the playback grant plus the object's
 *   size. The size is what the browser route's free-space check needs *before* a fetch starts
 *   (3.18.17), and the playback route deliberately does not carry it — a player never asks.
 * - **A series' sizes** (`GET /series/:id/download`) is the same question for "Download all"
 *   (3.18.6): the whole list, each with its bytes, so the check happens before the queue is built
 *   rather than during it (tdd 5.8). No URLs here — a grant is minted per recording when its turn
 *   in the queue comes, so a queue of twenty does not hold twenty signatures that expire together.
 * - **Sync** (`POST /sync`) is the outbox flush of tdd 5.3 and, in the same request, the question
 *   3.18.12 needs answered: "of the recordings I hold, which may I no longer hold". One request on
 *   reconnect rather than two, because reconnect on a phone is often a few seconds of signal.
 *
 * Nothing here carries media bytes or an object key: the bytes travel from the store to the device
 * under a signed URL, exactly as playback does.
 */

/** `GET /recordings/:id/download`. */
export function recordingDownloadPath(recordingId: string): string {
  return `${RECORDINGS_PATH}/${recordingId}/download`;
}

/** `GET /series/:id/download`. */
export function seriesDownloadPath(seriesId: string): string {
  return `${SERIES_PATH}/${seriesId}/download`;
}

/** `POST /sync`. */
export const SYNC_PATH = '/sync';

/** The downloads section of the profile, on the web origin ([3.18.10](docs/project/prd.md)). */
export const PROFILE_DOWNLOADS_PAGE_PATH = `${PROFILE_PAGE_PATH}/downloads`;

/**
 * Payload of `GET /recordings/:id/download` — the playback grant with the object's size beside it.
 *
 * `bytes` is what the store reports for the object the grant names, read at minting time. It is
 * the number the free-space check and the progress bar are built on; a download whose byte count
 * ends up different (a rendition replaced between the two requests) is stored at the size it
 * arrived at.
 */
export interface DownloadGrantPayload {
  readonly url: string;
  /** ISO 8601. The same hour the playback grant gets. */
  readonly expiresAt: string;
  readonly bytes: number;
  readonly contentType: string;
}

/** One recording of a series as "Download all" sees it: what it is and what it would cost. */
export interface SeriesDownloadItem {
  readonly id: string;
  readonly title: string;
  /** `YYYY-MM-DD`, so "the most recent recordings that do fit" (3.18.17) is decidable client-side. */
  readonly recordedAt: string;
  readonly bytes: number;
}

/** Payload of `GET /series/:id/download`, in the series' own order (newest recorded first). */
export interface SeriesDownloadPayload {
  readonly recordings: readonly SeriesDownloadItem[];
}

/**
 * What an outbox entry is about. Progress and notes are the two writes a member can make while
 * listening offline today ([3.18.14](docs/project/prd.md), [3.18.15](docs/project/prd.md));
 * tdd 5.3 names questionnaire answers and Flow Tracker responses as later members of this list.
 */
export const SYNC_ENTRY_KINDS = ['progress', 'note'] as const;
export type SyncEntryKind = (typeof SYNC_ENTRY_KINDS)[number];

/**
 * A client-generated id, as tdd 5.3 asks for, so that an outbox flushed twice — the phone lost
 * signal between the request and the answer — writes once. UUID-shaped, which is what the client
 * mints and what the receipt table is keyed on.
 */
export const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isClientId(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_ID_PATTERN.test(value);
}

interface SyncEntryBase {
  readonly clientId: string;
  readonly recordingId: string;
  /** When the write was made on the device, ISO 8601. Recorded, never used to order or refuse. */
  readonly at: string;
}

/**
 * A position written offline. Applied as written: the operator's decision for this ticket is that
 * an offline write always wins over whatever another device wrote in the meantime, which keeps the
 * progress endpoint's plain last-write-wins and makes the outbox a late arrival of the same write.
 */
export interface SyncProgressEntry extends SyncEntryBase {
  readonly kind: 'progress';
  readonly body: PlaybackProgressRequest;
}

/** A top-level note written offline. Replies are not written offline: a reply needs its parent live. */
export interface SyncNoteEntry extends SyncEntryBase {
  readonly kind: 'note';
  readonly body: CreateNoteRequest;
}

export type SyncEntry = SyncProgressEntry | SyncNoteEntry;

/** Body of `POST /sync`. */
export interface SyncRequest {
  /** The outbox, oldest first. Empty is allowed: a client with nothing to send still asks `downloaded`. */
  readonly entries: readonly SyncEntry[];
  /** The ids of every recording this device holds a download of, so the server can say which to drop. */
  readonly downloaded: readonly string[];
}

/** The most one flush carries. A phone that wrote more offline than this flushes in several. */
export const MAX_SYNC_ENTRIES = 200;

/** The most downloads one device can ask about at once; nobody holds more teachings than this. */
export const MAX_SYNC_DOWNLOADED = 500;

/**
 * What became of one entry.
 *
 * - `applied` — written, and for a note the row it became is beside it so the client can replace
 *   its pending copy with the real one.
 * - `refused` — the server said no, with the same code and message the live route would have
 *   answered. The client keeps a refused note as a draft and tells the member (the operator's
 *   decision for this ticket); a refused position is dropped, as a dropped live write is.
 * - `duplicate` — this client id was applied by an earlier flush. Nothing was written again.
 */
export const SYNC_RESULT_STATUSES = ['applied', 'refused', 'duplicate'] as const;
export type SyncResultStatus = (typeof SYNC_RESULT_STATUSES)[number];

export interface SyncEntryResult {
  readonly clientId: string;
  readonly status: SyncResultStatus;
  readonly code: ApiErrorCode | null;
  readonly message: string | null;
  /** The note an applied note entry became; `null` for every other entry. */
  readonly note: NoteView | null;
}

/** Payload of `POST /sync`. */
export interface SyncPayload {
  readonly results: readonly SyncEntryResult[];
  /**
   * Which of `downloaded` this member may no longer hold — unpublished since, or deleted. The
   * client removes each from the device (3.18.12): server-side deletions win (tdd 5.3).
   */
  readonly revoked: readonly string[];
  /** When the server answered, ISO 8601. */
  readonly syncedAt: string;
}
