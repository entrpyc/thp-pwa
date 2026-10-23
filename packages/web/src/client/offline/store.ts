import type { DownloadRecord } from './schema';

/**
 * **Where downloads live** ([3.18](docs/project/prd.md); project tdd 2.1, 4.3, 5.8) — one
 * interface, three implementations.
 *
 * The browser route holds bytes in IndexedDB, which the browser may cap or reclaim, so it reports
 * what the device has free and the queue refuses what would not fit (3.18.17). The store shell
 * holds them on the app's own filesystem, which the OS does not evict, and reports `null` for
 * free space — not "unknown" but "not subject to the check", as the PRD puts it. The fake holds
 * them in memory for the unit tests of everything built on this interface.
 *
 * **Fetching is the store's job, not the queue's**, and that is the one surprising line in the
 * interface. A browser download is a `fetch` read chunk by chunk into a `Blob`; a shell download
 * is the Filesystem plugin's native `downloadFile`, which streams straight to disk and reports
 * progress from the native side — a 150 MB teaching never passes through JavaScript as a string.
 * Those are two different mechanisms for one step, so the step belongs behind the interface and
 * the queue only says "here is a grant, tell me how it goes".
 */

/** The record before its bytes have arrived: everything but the size as stored and the location. */
export type DownloadDraft = Omit<DownloadRecord, 'location' | 'downloadedAt'>;

/** A signed `GET` and what the store said it would deliver. */
export interface DownloadSource {
  readonly url: string;
  readonly bytes: number;
  readonly contentType: string;
}

export interface FetchProgress {
  (loadedBytes: number): void;
}

/** Raised by `fetchInto` when the caller's signal aborted the transfer. Nothing is kept. */
export class DownloadCancelled extends Error {
  constructor() {
    super('The download was cancelled.');
    this.name = 'DownloadCancelled';
  }
}

export interface DownloadStore {
  readonly kind: 'browser' | 'shell' | 'memory';
  /** Every download this member holds, newest downloaded first. */
  list(userId: string): Promise<DownloadRecord[]>;
  get(userId: string, recordingId: string): Promise<DownloadRecord | null>;
  /**
   * Fetch the bytes and persist the record with them. Progress is reported as bytes loaded so far;
   * `signal` cancels, after which nothing of this download remains in the store.
   */
  fetchInto(
    draft: DownloadDraft,
    source: DownloadSource,
    onProgress: FetchProgress,
    signal: AbortSignal,
  ): Promise<DownloadRecord>;
  /** Rewrite a record's metadata — refreshed notes, a newer progress — leaving the bytes alone. */
  update(record: DownloadRecord): Promise<void>;
  remove(userId: string, recordingId: string): Promise<void>;
  /**
   * A URL the `<audio>` element can play this download from, or `null` when the bytes are gone.
   * The caller releases it with {@link DownloadStore.releaseUrl} when the element moves on.
   */
  localUrl(record: DownloadRecord): Promise<string | null>;
  releaseUrl(url: string): void;
  /** What the device reports free, in bytes — or `null` where the check does not apply. */
  freeBytes(): Promise<number | null>;
}

/**
 * The fake: downloads come from a map of bytes the test seeds, and progress is reported in a
 * handful of steps so a test can watch the number move. Everything the interface promises holds —
 * a cancelled fetch keeps nothing, `localUrl` answers a stable string per record — without a
 * browser.
 */
export function createMemoryDownloadStore(
  options: {
    readonly bytesFor?: (url: string) => Uint8Array | null;
    readonly freeBytes?: number | null;
    /** How many progress steps a fetch reports. */
    readonly steps?: number;
  } = {},
): DownloadStore & {
  readonly records: Map<string, DownloadRecord>;
  readonly media: Map<string, Uint8Array>;
  setFreeBytes(bytes: number | null): void;
} {
  const records = new Map<string, DownloadRecord>();
  const media = new Map<string, Uint8Array>();
  let free = options.freeBytes ?? null;
  const steps = Math.max(1, options.steps ?? 4);

  return {
    kind: 'memory',
    records,
    media,
    setFreeBytes(bytes) {
      free = bytes;
    },
    async list(userId) {
      return [...records.values()]
        .filter((one) => one.userId === userId)
        .sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt));
    },
    async get(userId, recordingId) {
      return records.get(`${userId}:${recordingId}`) ?? null;
    },
    async fetchInto(draft, source, onProgress, signal) {
      const bytes = options.bytesFor?.(source.url) ?? new Uint8Array(source.bytes);
      for (let step = 1; step <= steps; step += 1) {
        // A microtask boundary per step, so a cancellation issued between steps lands between them.
        await Promise.resolve();
        if (signal.aborted) throw new DownloadCancelled();
        onProgress(Math.round((bytes.byteLength * step) / steps));
      }
      const record: DownloadRecord = {
        ...draft,
        bytes: bytes.byteLength,
        location: { kind: 'idb' },
        downloadedAt: new Date().toISOString(),
      };
      records.set(record.key, record);
      media.set(record.key, bytes);
      return record;
    },
    async update(record) {
      if (records.has(record.key)) records.set(record.key, record);
    },
    async remove(userId, recordingId) {
      records.delete(`${userId}:${recordingId}`);
      media.delete(`${userId}:${recordingId}`);
    },
    async localUrl(record) {
      return media.has(record.key) ? `memory://${record.key}` : null;
    },
    releaseUrl() {
      // Nothing was allocated.
    },
    async freeBytes() {
      return free;
    },
  };
}
