import { BY_USER_INDEX, OFFLINE_STORES, downloadKey, type DownloadRecord } from './schema';
import { idbAllBy, idbDelete, idbGet, idbPut } from './idb';
import { DownloadCancelled, type DownloadStore } from './store';

/**
 * **Downloads on the browser route** ([3.18.17](docs/project/prd.md); project tdd 5.8).
 *
 * Bytes live in IndexedDB as a `Blob`, beside the record that describes them. IndexedDB rather
 * than the Cache API for the bytes too, because a `Blob` under a key the record names is one
 * thing to delete and one thing to measure, where a cache entry keyed by a signed URL that
 * expires in an hour is neither. The browser may cap this storage or reclaim it under pressure —
 * that is the whole reason the free-space check exists — and `navigator.storage.persist()` is
 * asked for once, which on Chrome turns eviction off for an installed app and on Safari does
 * nothing a member can see.
 *
 * **The fetch reads the body chunk by chunk** so progress is real rather than the two states a
 * plain `fetch` gives. The chunks are gathered into one `Blob` at the end: a member with a 150 MB
 * teaching holds 150 MB in memory for a moment while it is written, which is the price of a
 * single `put` rather than a hundred partial records that could be evicted halfway.
 *
 * **Free space is `navigator.storage.estimate()`**, read every time it is asked for rather than
 * once: it changes with every download and with whatever else the device is doing. A browser
 * without the API answers `null`, which the queue reads as "not subject to the check" — the same
 * answer a store build gives — because refusing every download on a browser that cannot say is
 * worse than the eviction it would prevent.
 */
export function createBrowserDownloadStore(): DownloadStore {
  let persistenceAsked = false;

  async function askPersistence(): Promise<void> {
    if (persistenceAsked) return;
    persistenceAsked = true;
    try {
      await navigator.storage?.persist?.();
    } catch {
      // Best-effort; a refusal changes nothing the page can act on.
    }
  }

  return {
    kind: 'browser',

    async list(userId) {
      const records = await idbAllBy<DownloadRecord>(OFFLINE_STORES.downloads, BY_USER_INDEX, userId);
      return records.sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt));
    },

    async get(userId, recordingId) {
      return (await idbGet<DownloadRecord>(OFFLINE_STORES.downloads, downloadKey(userId, recordingId))) ?? null;
    },

    async fetchInto(draft, source, onProgress, signal) {
      await askPersistence();
      const response = await fetch(source.url, { signal, credentials: 'omit' });
      if (!response.ok) throw new Error(`The store answered ${response.status}.`);
      if (response.body === null) throw new Error('The store sent no body.');

      const reader = response.body.getReader();
      const chunks: BlobPart[] = [];
      let loaded = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) {
            chunks.push(value);
            loaded += value.byteLength;
            onProgress(loaded);
          }
        }
      } catch (caught) {
        if (signal.aborted) throw new DownloadCancelled();
        throw caught;
      }
      if (signal.aborted) throw new DownloadCancelled();

      const blob = new Blob(chunks, {
        type: response.headers.get('content-type') ?? source.contentType,
      });
      const record: DownloadRecord = {
        ...draft,
        bytes: blob.size,
        contentType: blob.type,
        location: { kind: 'idb' },
        downloadedAt: new Date().toISOString(),
      };
      // Bytes first, record second: a record without bytes is a download the player would try to
      // open and find empty, where bytes without a record are an orphan the next remove clears.
      await idbPut(OFFLINE_STORES.media, blob, record.key);
      await idbPut(OFFLINE_STORES.downloads, record);
      return record;
    },

    async update(record) {
      await idbPut(OFFLINE_STORES.downloads, record);
    },

    async remove(userId, recordingId) {
      const key = downloadKey(userId, recordingId);
      await idbDelete(OFFLINE_STORES.downloads, key);
      await idbDelete(OFFLINE_STORES.media, key);
    },

    async localUrl(record) {
      const blob = await idbGet<Blob>(OFFLINE_STORES.media, record.key);
      if (blob === undefined) return null;
      return URL.createObjectURL(blob);
    },

    releaseUrl(url) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    },

    async freeBytes() {
      try {
        const estimate = await navigator.storage?.estimate?.();
        if (estimate === undefined || estimate.quota === undefined) return null;
        return Math.max(0, estimate.quota - (estimate.usage ?? 0));
      } catch {
        return null;
      }
    },
  };
}
