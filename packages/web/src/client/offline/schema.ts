import type {
  ChapterView,
  CreateNoteRequest,
  NoteView,
  PlaybackProgressPayload,
  PlaybackProgressRequest,
  RecordingView,
  ScriptureReadingView,
  SyncEntryKind,
} from '@thp/shared';

/**
 * **The on-device database** ([3.18](docs/project/prd.md); project tdd 2.1, 5.1.7) — one
 * IndexedDB, four object stores, and the shapes in them.
 *
 * IndexedDB rather than the Cache API for everything but pages, because the data here is *read
 * back and reasoned over* — which teachings this member holds, what the outbox says, what a series
 * is made of — and a cache can only answer "do you have this URL". And one database rather than a
 * database per concern, because the service worker's offline module reads the same stores from
 * the same origin: it is what lets the worker answer `GET /api/v1/recordings` offline with the
 * downloads the page wrote, and let the page count the outbox entries the worker wrote.
 *
 * **The worker cannot import this file.** `public/sw/offline.js` is a plain script outside the
 * bundle, so it carries its own copy of the names below, and `tests/unit/offline-schema.test.ts`
 * reads that file and holds the two copies to each other. Change a name here and the test says
 * where else to change it.
 *
 * **Keys carry the account.** Downloads and outbox entries are keyed under the member who made
 * them (the operator's decision for this ticket: downloads survive sign-out, scoped to the
 * account), so a second account on the same device starts with nothing and the first finds theirs
 * on return. Downloads, the outbox and the pictures waiting with it are **not** cleared on
 * sign-out, for that reason.
 *
 * **What sign-out does clear** (the security audit of 28 October 2026, finding 11): the `meta`
 * facts about *who* is signed in — the active-user marker and that account's kept session
 * payload. Neither is a download; both would tell the next person on a shared device who was here
 * before them. The kept session payload also never carries the e-mail address, whatever the
 * server answered (`offline-api.ts`, `storedSession`): offline, the surface needs a name, a role,
 * a speed and an avatar, and an address held on the device is an address a device can leak. The
 * worker's page cache is cleared as well, which is a different store with a different reason.
 */

export const OFFLINE_DB_NAME = 'thp-offline';
/** 2 added `noteImages`: the bytes of pictures attached to notes written offline (3.12.22). */
export const OFFLINE_DB_VERSION = 2;

export const OFFLINE_STORES = {
  /** One {@link DownloadRecord} per download. */
  downloads: 'downloads',
  /** The bytes of a browser-route download, as a `Blob`, under the download's key. Unused in a store build. */
  media: 'media',
  /** One {@link OutboxRecord} per write made offline. */
  outbox: 'outbox',
  /** Small facts: which account is active, the last session payload per account. */
  meta: 'meta',
  /** One {@link PendingImageRecord} per picture waiting on a connection. */
  noteImages: 'noteImages',
} as const;

/** The index on `downloads` and `outbox` that answers "everything this member holds". */
export const BY_USER_INDEX = 'byUser';

/** The `meta` key naming the signed-in account, so the worker knows whose downloads to serve. */
export const ACTIVE_USER_KEY = 'activeUser';

/** The `meta` key under which the worker keeps the last `GET /auth/session` answer per account. */
export function sessionMetaKey(userId: string): string {
  return `session:${userId}`;
}

export function downloadKey(userId: string, recordingId: string): string {
  return `${userId}:${recordingId}`;
}

/** Where a download's bytes are: in this database, or on the shell's filesystem. */
export type DownloadLocation =
  | { readonly kind: 'idb' }
  | {
      readonly kind: 'file';
      /** The path under the Capacitor data directory. */
      readonly path: string;
      /** The native `file://` URI the plugin answered, for `convertFileSrc`. */
      readonly uri: string;
    };

/**
 * One downloaded teaching, with everything 3.18.3 and 3.18.4 say travels with it.
 *
 * The recording payload, the chapters, the scripture readings and the notes are the member-facing
 * payloads exactly as the API answered them, so the worker can hand them back offline without
 * reshaping anything — and refresh them from every successful online answer that passes through
 * it. `progress` is the last position the server reported; the outbox may hold a newer one.
 */
export interface DownloadRecord {
  readonly key: string;
  readonly userId: string;
  readonly recordingId: string;
  readonly title: string;
  readonly seriesId: string | null;
  readonly seriesTitle: string | null;
  /** `YYYY-MM-DD`, for ordering offline lists the way the library orders them. */
  readonly recordedAt: string;
  /** What the store reported the object to be; the progress bar's denominator (3.18.8). */
  readonly bytes: number;
  readonly contentType: string;
  /** ISO 8601 — the date the downloads section prints (3.18.10). */
  readonly downloadedAt: string;
  readonly location: DownloadLocation;
  readonly recording: RecordingView;
  readonly chapters: readonly ChapterView[];
  readonly scripture: readonly ScriptureReadingView[];
  readonly notes: readonly NoteView[];
  readonly progress: PlaybackProgressPayload | null;
}

/** One write made offline, waiting for a connection (project tdd 5.3). */
export interface OutboxRecord {
  readonly clientId: string;
  readonly userId: string;
  readonly kind: SyncEntryKind;
  readonly recordingId: string;
  /** ISO 8601, the device's clock. */
  readonly at: string;
  readonly body: PlaybackProgressRequest | CreateNoteRequest;
}

/**
 * A picture chosen for a note while offline: the encoded bytes under the pending id the outbox
 * entry names. The flush uploads it, swaps a key into the entry and removes this row
 * ([3.12.22](docs/project/prd.md); `client/notes/images.ts`).
 */
export interface PendingImageRecord {
  readonly id: string;
  readonly userId: string;
  readonly blob: Blob;
  readonly contentType: string;
  readonly alt: string | null;
}
