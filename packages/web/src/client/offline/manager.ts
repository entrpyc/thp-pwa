import {
  DASHBOARD_PAGE_PATH,
  MAX_SYNC_ENTRIES,
  MEMBER_SERIES_PAGE_PATH,
  PROFILE_DOWNLOADS_PAGE_PATH,
  SYNC_PATH,
  describeBytes,
  memberRecordingPath,
  recordingChaptersPath,
  recordingDownloadPath,
  recordingNotesPath,
  recordingPagePath,
  recordingProgressPath,
  recordingScripturePath,
  seriesDownloadPath,
  seriesPagePath,
  type ChaptersPayload,
  type DownloadGrantPayload,
  type NotesPayload,
  type PlaybackProgressPayload,
  type PlaybackProgressRequest,
  type RecordingPayload,
  type RecordingScripturePayload,
  type SeriesDownloadPayload,
  type SyncPayload,
  type SyncRequest,
} from '@thp/shared';
import { ApiClientError, apiFetch, installOfflineHooks } from '@/client/api-client';
import { clearAllNoteDrafts, readNoteDraft, writeNoteDraft } from '@/client/notes/draft';
import { shellPlatform } from '@/client/platform';
import { createBrowserDownloadStore } from './browser-store';
import { forgetActiveAccount } from './forget';
import { sessionMetaKey } from './schema';

/** What every per-account session entry in `meta` starts with — `sessionMetaKey('')`. */
const SESSION_META_PREFIX = sessionMetaKey('');
import { idbDelete, idbKeys, idbPut } from './idb';
import { createOfflineHooks } from './offline-api';
import { forgetPendingImages, prepareOutboxImages } from './pending-images';
import {
  appendProgress,
  applySyncResults,
  countOutbox,
  listOutbox,
  removeOutbox,
  toSyncEntries,
} from './outbox';
import {
  EMPTY_QUEUE,
  cancel as cancelItem,
  enqueue,
  fail,
  finish,
  fitsAlone,
  nextQueued,
  overall,
  planSeriesDownload,
  progress as progressItem,
  prune,
  start,
  type OverallProgress,
  type QueueState,
  type SeriesPlan,
} from './queue';
import { ACTIVE_USER_KEY, OFFLINE_STORES, downloadKey, type DownloadRecord } from './schema';
import { createShellDownloadStore } from './shell-store';
import { DownloadCancelled, type DownloadDraft, type DownloadStore } from './store';

/**
 * **The download manager** — the one object the controls, the indicator, the downloads section
 * and the player read ([3.18](docs/project/prd.md); project tdd 2.1).
 *
 * A module-level store with `subscribe`/`getSnapshot`, not
 * React state: the queue runs while the member walks between pages (3.18.7), a control mounts
 * long after the queue started, and the player asks it for a local source from outside React.
 *
 * It owns: which store this device uses (the shell's filesystem in a store build, IndexedDB
 * otherwise, decided once from `shellPlatform()`); the queue and its progress; the outbox flush;
 * the notices a member has to see; and the account everything is keyed under. It decides nothing
 * about what a member may download — the grant route refuses, and the manager reports that.
 *
 * The outbox has two writers and one reader. The player appends positions through
 * {@link OfflineManager.keepProgress} when a write cannot reach the server; the worker's offline
 * module appends notes. The flush here sends both and applies the answer: a refused note returns
 * as a draft, a revoked download is removed (3.18.12), and `thp:synced` is dispatched on the
 * window so the player reads the touched teachings' notes again.
 *
 * Built by a factory so the unit tests hand in the memory store and a fake fetch.
 */

/** The window event dispatched after a flush, carrying the ids of teachings whose notes changed. */
export const SYNCED_EVENT = 'thp:synced';

export interface Notice {
  readonly id: number;
  readonly text: string;
}

export interface OfflineSnapshot {
  readonly userId: string | null;
  /** Whether the downloads list has been read from the store at least once. */
  readonly ready: boolean;
  readonly online: boolean;
  readonly storeKind: DownloadStore['kind'] | null;
  readonly downloads: readonly DownloadRecord[];
  readonly queue: QueueState;
  readonly overall: OverallProgress;
  /** Outbox entries waiting for a connection (3.18.16). */
  readonly pending: number;
  readonly syncing: boolean;
  readonly notices: readonly Notice[];
  readonly totalBytes: number;
  readonly freeBytes: number | null;
}

export const SERVER_SNAPSHOT: OfflineSnapshot = {
  userId: null,
  ready: false,
  online: true,
  storeKind: null,
  downloads: [],
  queue: EMPTY_QUEUE,
  overall: overall(EMPTY_QUEUE),
  pending: 0,
  syncing: false,
  notices: [],
  totalBytes: 0,
  freeBytes: null,
};

export type JsonFetch = <T>(path: string, init?: RequestInit) => Promise<T>;

export interface OfflineManagerOptions {
  readonly store: DownloadStore;
  readonly fetchJson: JsonFetch;
  /** Reads the outbox for the flush; the real one is IndexedDB, a test's is a list. */
  readonly outbox?: {
    list(userId: string): Promise<Parameters<typeof toSyncEntries>[0]>;
    count(userId: string): Promise<number>;
    remove(clientIds: readonly string[]): Promise<void>;
    appendProgress(userId: string, recordingId: string, body: PlaybackProgressRequest): Promise<unknown>;
  };
  readonly rememberActiveUser?: (userId: string) => Promise<void>;
  /** The inverse, for sign-out; the real one is {@link forgetActiveAccount}. */
  readonly forgetActiveUser?: () => Promise<void>;
  readonly warm?: (urls: readonly string[]) => void;
  readonly isOnline?: () => boolean;
}

export interface OfflineManager {
  subscribe(listener: () => void): () => void;
  getSnapshot(): OfflineSnapshot;
  /** Name the signed-in account. Loads its downloads, counts its outbox, and flushes if online. */
  activate(userId: string): Promise<void>;
  /**
   * The account is leaving this device: sign-out, or the account being deleted. Stops any
   * transfer in flight, forgets who was signed in and drops every note draft on the device
   * (`forget.ts` and `@/client/notes/draft` say what and why). Downloads stay, under the account.
   */
  deactivate(): Promise<void>;
  /** Queue one teaching. The title is for the queue row until the payload arrives. */
  download(recordingId: string, title: string): void;
  /** Size up a series without queueing anything: the sheet decides from the plan. */
  planSeries(seriesId: string): Promise<SeriesPlan>;
  downloadMany(items: readonly { id: string; title: string; bytes: number }[]): void;
  cancel(recordingId: string): void;
  remove(recordingId: string): Promise<void>;
  isDownloaded(recordingId: string): boolean;
  /** A URL the player can point the element at, or `null`. Released with {@link releaseSource}. */
  localSourceFor(recordingId: string): Promise<string | null>;
  releaseSource(url: string): void;
  /** Keep a position the server could not be reached for. */
  keepProgress(recordingId: string, body: PlaybackProgressRequest): Promise<void>;
  flush(): Promise<void>;
  dismissNotice(id: number): void;
  /** Called by the worker's message, or a test: the outbox or a download changed under us. */
  reload(): Promise<void>;
}

export function createOfflineManager(options: OfflineManagerOptions): OfflineManager {
  const { store, fetchJson } = options;
  const outbox = options.outbox ?? {
    list: listOutbox,
    count: countOutbox,
    remove: removeOutbox,
    appendProgress,
  };
  const rememberActiveUser =
    options.rememberActiveUser ??
    (async (userId: string) => {
      await idbPut(OFFLINE_STORES.meta, { userId }, ACTIVE_USER_KEY);
    });
  const forgetActiveUser = options.forgetActiveUser ?? forgetActiveAccount;
  /** Drop every `session:<id>` entry in `meta` that is not this account's. */
  async function forgetForeignSessions(userId: string): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    const own = sessionMetaKey(userId);
    for (const key of await idbKeys(OFFLINE_STORES.meta)) {
      if (typeof key === 'string' && key.startsWith(SESSION_META_PREFIX) && key !== own) {
        await idbDelete(OFFLINE_STORES.meta, key);
      }
    }
  }
  const warm =
    options.warm ??
    ((urls: readonly string[]) => {
      if (typeof navigator === 'undefined') return;
      navigator.serviceWorker?.controller?.postMessage({ type: 'thp:warm', urls });
    });
  const isOnline = options.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  let snapshot: OfflineSnapshot = { ...SERVER_SNAPSHOT, storeKind: store.kind, online: isOnline() };
  const listeners = new Set<() => void>();
  const controllers = new Map<string, AbortController>();
  let noticeSeq = 0;
  let running = false;
  let flushing: Promise<void> | null = null;

  function set(change: Partial<OfflineSnapshot>): void {
    snapshot = { ...snapshot, ...change };
    if (change.queue !== undefined) snapshot = { ...snapshot, overall: overall(snapshot.queue) };
    if (change.downloads !== undefined) {
      snapshot = {
        ...snapshot,
        totalBytes: snapshot.downloads.reduce((sum, one) => sum + one.bytes, 0),
      };
    }
    for (const listener of listeners) listener();
  }

  function notice(text: string): void {
    noticeSeq += 1;
    set({ notices: [...snapshot.notices, { id: noticeSeq, text }] });
  }

  async function reload(): Promise<void> {
    const userId = snapshot.userId;
    if (userId === null) return;
    const [downloads, pending, freeBytes] = await Promise.all([
      store.list(userId).catch(() => []),
      outbox.count(userId).catch(() => 0),
      store.freeBytes(),
    ]);
    set({ downloads, pending, freeBytes, ready: true });
  }

  /** Everything 3.18.3 and 3.18.4 say travels with a download, read before the bytes. */
  async function describe(userId: string, recordingId: string): Promise<DownloadDraft> {
    const [recording, chapters, notes, progress] = await Promise.all([
      fetchJson<RecordingPayload>(memberRecordingPath(recordingId)),
      fetchJson<ChaptersPayload>(recordingChaptersPath(recordingId)),
      fetchJson<NotesPayload>(recordingNotesPath(recordingId)),
      fetchJson<PlaybackProgressPayload>(recordingProgressPath(recordingId)),
    ]);
    const scripture = recording.recording.hasScripture
      ? (await fetchJson<RecordingScripturePayload>(recordingScripturePath(recordingId))).references
      : [];
    return {
      key: downloadKey(userId, recordingId),
      userId,
      recordingId,
      title: recording.recording.title,
      seriesId: recording.recording.series?.id ?? null,
      seriesTitle: recording.recording.series?.title ?? null,
      recordedAt: recording.recording.recordedAt,
      bytes: 0,
      contentType: '',
      recording: recording.recording,
      chapters: chapters.chapters,
      scripture,
      notes: notes.notes,
      progress,
    };
  }

  function pagesFor(record: DownloadRecord): string[] {
    return [
      DASHBOARD_PAGE_PATH,
      MEMBER_SERIES_PAGE_PATH,
      PROFILE_DOWNLOADS_PAGE_PATH,
      recordingPagePath(record.recordingId),
      ...(record.seriesId === null ? [] : [seriesPagePath(record.seriesId)]),
    ];
  }

  async function runOne(recordingId: string): Promise<void> {
    const userId = snapshot.userId;
    if (userId === null) return;
    const controller = new AbortController();
    controllers.set(recordingId, controller);
    set({ queue: start(snapshot.queue, recordingId) });
    try {
      const grant = await fetchJson<DownloadGrantPayload>(recordingDownloadPath(recordingId));
      set({ queue: start(snapshot.queue, recordingId, grant.bytes) });

      const free = await store.freeBytes();
      if (!fitsAlone(grant.bytes, free)) {
        set({
          queue: fail(
            snapshot.queue,
            recordingId,
            `Not enough space: this teaching needs ${describeBytes(grant.bytes)} and ${describeBytes(free ?? 0)} is free.`,
          ),
        });
        return;
      }

      const draft = await describe(userId, recordingId);
      const record = await store.fetchInto(
        draft,
        { url: grant.url, bytes: grant.bytes, contentType: grant.contentType },
        (loaded) => set({ queue: progressItem(snapshot.queue, recordingId, loaded) }),
        controller.signal,
      );
      set({ queue: finish(snapshot.queue, recordingId) });
      warm(pagesFor(record));
    } catch (caught) {
      if (caught instanceof DownloadCancelled) {
        set({ queue: cancelItem(snapshot.queue, recordingId) });
      } else {
        const message = caught instanceof Error ? caught.message : 'The download failed.';
        set({ queue: fail(snapshot.queue, recordingId, message) });
      }
    } finally {
      controllers.delete(recordingId);
      await reload();
    }
  }

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (let next = nextQueued(snapshot.queue); next !== null; next = nextQueued(snapshot.queue)) {
        await runOne(next.recordingId);
      }
    } finally {
      running = false;
    }
  }

  async function flush(): Promise<void> {
    if (flushing !== null) return flushing;
    const userId = snapshot.userId;
    if (userId === null || !isOnline()) return;
    flushing = (async () => {
      const listed = (await outbox.list(userId)).slice(0, MAX_SYNC_ENTRIES);
      const downloaded = snapshot.downloads.map((one) => one.recordingId);
      if (listed.length === 0 && downloaded.length === 0) return;
      set({ syncing: true });
      try {
        // Pictures first: a note written offline names bytes kept on the device, and the server
        // takes only keys. An entry whose pictures could not all go up stays home this round.
        const prepared = await prepareOutboxImages(listed, fetchJson);
        const sent = prepared.ready;
        if (prepared.dropped > 0) {
          notice(
            prepared.dropped === 1
              ? 'A picture on a note written offline was no longer on this device and was left out.'
              : `${prepared.dropped} pictures on notes written offline were no longer on this device and were left out.`,
          );
        }
        const request: SyncRequest = { entries: toSyncEntries(sent), downloaded };
        const payload = await fetchJson<SyncPayload>(SYNC_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        });
        const outcome = applySyncResults(sent, payload.results);
        await outbox.remove(outcome.settled);
        await forgetPendingImages(prepared.pendingIds);

        for (const refused of outcome.refusedNotes) {
          if (refused.recordingGone) {
            notice(`A note written offline could not be saved: ${refused.message}`);
            continue;
          }
          // Appended under an existing draft rather than over it: the member may be writing.
          const held = readNoteDraft(userId, refused.recordingId);
          writeNoteDraft(userId, refused.recordingId, {
            text: held === null ? refused.text : `${held.text}\n\n${refused.text}`,
            visibility: refused.visibility,
            anchorMs: held?.anchorMs ?? refused.anchorMs,
          });
          notice(`A note written offline was not saved and is back in the composer: ${refused.message}`);
        }
        if (outcome.droppedPositions > 0) {
          notice('A listening position written offline could not be saved.');
        }
        for (const recordingId of payload.revoked) {
          const gone = snapshot.downloads.find((one) => one.recordingId === recordingId);
          await store.remove(userId, recordingId);
          if (gone !== undefined) notice(`“${gone.title}” is no longer available and was removed from your downloads.`);
        }
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent(SYNCED_EVENT, { detail: outcome.touchedRecordings }));
        }
        set({ online: true });
      } catch (caught) {
        // The next reconnect tries again; nothing was removed from the outbox. A server that could
        // not be reached at all is the second reading of "offline" beside `navigator.onLine`,
        // which some browsers leave true behind a dead connection; a server that answered is not.
        if (!(caught instanceof ApiClientError)) set({ online: false });
      } finally {
        set({ syncing: false });
        await reload();
      }
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      set({ online: true });
      void flush();
    });
    window.addEventListener('offline', () => set({ online: false }));
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,

    async activate(userId) {
      if (snapshot.userId === userId && snapshot.ready) return;
      set({ userId, ready: false, downloads: [], queue: EMPTY_QUEUE, online: isOnline() });
      await rememberActiveUser(userId).catch(() => undefined);
      // The last session answer kept for any *other* account goes now: it was written for whoever
      // used this device before, and the member just admitted has no business reading it
      // (docs/security-audit-2026-10-29.md, finding 22).
      await forgetForeignSessions(userId).catch(() => undefined);
      await reload();
      void flush();
    },

    async deactivate() {
      // A transfer still running would write a download under an account that has just left;
      // cancelling it is what `remove` does for one teaching, applied to all of them.
      for (const controller of controllers.values()) controller.abort();
      clearAllNoteDrafts();
      await forgetActiveUser().catch(() => undefined);
      set({ ...SERVER_SNAPSHOT, storeKind: store.kind, online: isOnline() });
    },

    download(recordingId, title) {
      set({ queue: enqueue(prune(snapshot.queue), { recordingId, title, bytes: 0 }) });
      void run();
    },

    async planSeries(seriesId) {
      const [payload, freeBytes] = await Promise.all([
        fetchJson<SeriesDownloadPayload>(seriesDownloadPath(seriesId)),
        store.freeBytes(),
      ]);
      const held = new Set<string>([
        ...snapshot.downloads.map((one) => one.recordingId),
        ...snapshot.queue.items.filter((one) => one.status === 'queued' || one.status === 'downloading').map((one) => one.recordingId),
      ]);
      return planSeriesDownload({ recordings: payload.recordings, held, freeBytes });
    },

    downloadMany(items) {
      let queue = prune(snapshot.queue);
      for (const item of items) queue = enqueue(queue, { recordingId: item.id, title: item.title, bytes: item.bytes });
      set({ queue });
      void run();
    },

    cancel(recordingId) {
      controllers.get(recordingId)?.abort();
      set({ queue: cancelItem(snapshot.queue, recordingId) });
    },

    async remove(recordingId) {
      const userId = snapshot.userId;
      if (userId === null) return;
      await store.remove(userId, recordingId);
      await reload();
    },

    isDownloaded(recordingId) {
      return snapshot.downloads.some((one) => one.recordingId === recordingId);
    },

    async localSourceFor(recordingId) {
      const userId = snapshot.userId;
      if (userId === null) return null;
      const record = await store.get(userId, recordingId).catch(() => null);
      if (record === null) return null;
      return store.localUrl(record);
    },

    releaseSource(url) {
      store.releaseUrl(url);
    },

    async keepProgress(recordingId, body) {
      const userId = snapshot.userId;
      if (userId === null) return;
      await outbox.appendProgress(userId, recordingId, body);
      await reload();
    },

    flush,

    dismissNotice(id) {
      set({ notices: snapshot.notices.filter((one) => one.id !== id) });
    },

    reload,
  };
}

/** The store this device uses: the shell's filesystem inside a store build, IndexedDB otherwise. */
function deviceStore(): DownloadStore {
  return shellPlatform() === null ? createBrowserDownloadStore() : createShellDownloadStore();
}

const withCredentials: JsonFetch = (path, init) =>
  apiFetch(path, { credentials: 'include', ...init });

let manager: OfflineManager | null = null;

/**
 * The page's one manager, created on first use so a server render never touches a store. Creating
 * it also installs the offline hooks on the API client: from then on a read the server cannot be
 * reached for is answered from the device, and every answer about a downloaded teaching refreshes
 * the stored copy (`offline-api.ts`).
 */
export function offlineManager(): OfflineManager {
  if (manager === null) {
    const created = createOfflineManager({ store: deviceStore(), fetchJson: withCredentials });
    installOfflineHooks(
      createOfflineHooks({
        onOutboxWrite: () => void created.reload(),
        onDownloadRefreshed: () => void created.reload(),
      }),
    );
    manager = created;
  }
  return manager;
}
