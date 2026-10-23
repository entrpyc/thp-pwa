import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { BY_USER_INDEX, OFFLINE_STORES, downloadKey, type DownloadRecord } from './schema';
import { idbAllBy, idbDelete, idbGet, idbPut } from './idb';
import { DownloadCancelled, type DownloadStore } from './store';

/**
 * **Downloads inside the store shell** (project tdd 2.1, 4.3; [3.18.17](docs/project/prd.md)'s
 * last sentence; packages/shell/README.md).
 *
 * The bytes go on the app's own filesystem through `@capacitor/filesystem` — the one thing the
 * shell contributes to this feature, and the reason the browser route's free-space check does not
 * apply here: the `Data` directory is the app's, deleted with the app and never evicted under
 * storage pressure, which neither IndexedDB nor a WebView cache can promise on iOS. The record
 * stays in IndexedDB beside the browser route's, so the worker's offline module serves a store
 * build's downloads through the same code — only `location` differs.
 *
 * **The plugin fetches, not the page.** `downloadFile` streams the signed URL straight to disk on
 * the native side and reports progress from there; the alternative — reading the body in the
 * WebView and handing it to `writeFile` — passes every byte through a base64 string, which for a
 * ninety-minute teaching is a quarter-gigabyte of JavaScript heap. The plugin has no cancel: an
 * abort here is honoured at the next progress event by deleting what arrived, which is the most
 * the API allows and leaves nothing behind.
 *
 * **Playback reads the file through `convertFileSrc`**, the URL under which the WebView's local
 * server exposes an app file to the page. Not yet proven on a device from this machine — see the
 * manual steps in the ticket's summary; if a device refuses it, `localUrl` falls back to reading
 * the file into a `Blob`, which plays everywhere at the memory cost above.
 *
 * One file per download under `downloads/<user>/<recording>`: the member's id in the path is what
 * keeps two accounts on one phone apart on disk as well as in the index.
 */

const DIRECTORY = Directory.Data;

function filePath(userId: string, recordingId: string, contentType: string): string {
  const extension = contentType.includes('mpeg') ? 'mp3' : contentType.includes('mp4') ? 'm4a' : 'bin';
  return `downloads/${userId}/${recordingId}.${extension}`;
}

export function createShellDownloadStore(): DownloadStore {
  return {
    kind: 'shell',

    async list(userId) {
      const records = await idbAllBy<DownloadRecord>(OFFLINE_STORES.downloads, BY_USER_INDEX, userId);
      return records.sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt));
    },

    async get(userId, recordingId) {
      return (await idbGet<DownloadRecord>(OFFLINE_STORES.downloads, downloadKey(userId, recordingId))) ?? null;
    },

    async fetchInto(draft, source, onProgress, signal) {
      const path = filePath(draft.userId, draft.recordingId, source.contentType);
      let listener: PluginListenerHandle | null = null;
      let aborted = false;
      try {
        listener = await Filesystem.addListener('progress', (status) => {
          if (status.url !== source.url) return;
          if (signal.aborted) aborted = true;
          onProgress(status.bytes);
        });
        const result = await Filesystem.downloadFile({
          url: source.url,
          path,
          directory: DIRECTORY,
          progress: true,
          recursive: true,
        });
        if (aborted || signal.aborted) {
          await Filesystem.deleteFile({ path, directory: DIRECTORY }).catch(() => undefined);
          throw new DownloadCancelled();
        }
        const { uri } = await Filesystem.getUri({ path, directory: DIRECTORY });
        const stat = await Filesystem.stat({ path, directory: DIRECTORY }).catch(() => null);
        const record: DownloadRecord = {
          ...draft,
          bytes: stat?.size ?? source.bytes,
          contentType: source.contentType,
          location: { kind: 'file', path: result.path ?? path, uri },
          downloadedAt: new Date().toISOString(),
        };
        await idbPut(OFFLINE_STORES.downloads, record);
        return record;
      } finally {
        await listener?.remove().catch(() => undefined);
      }
    },

    async update(record) {
      await idbPut(OFFLINE_STORES.downloads, record);
    },

    async remove(userId, recordingId) {
      const key = downloadKey(userId, recordingId);
      const record = await idbGet<DownloadRecord>(OFFLINE_STORES.downloads, key);
      await idbDelete(OFFLINE_STORES.downloads, key);
      if (record?.location.kind === 'file') {
        await Filesystem.deleteFile({ path: record.location.path, directory: DIRECTORY }).catch(
          () => undefined,
        );
      }
    },

    async localUrl(record) {
      if (record.location.kind !== 'file') return null;
      const present = await Filesystem.stat({ path: record.location.path, directory: DIRECTORY })
        .then(() => true)
        .catch(() => false);
      if (!present) return null;
      return Capacitor.convertFileSrc(record.location.uri);
    },

    releaseUrl() {
      // A file URL allocates nothing in the page.
    },

    async freeBytes() {
      // Not subject to the check (3.18.17): the OS does not evict the data directory.
      return null;
    },
  };
}
