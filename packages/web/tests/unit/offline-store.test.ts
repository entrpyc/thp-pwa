import { describe, expect, it, vi } from 'vitest';
import { DownloadCancelled, createMemoryDownloadStore, type DownloadDraft } from '@/client/offline/store';

/**
 * **The storage interface, held through the fake** (docs/project/prd.md 3.18; project tdd 5.8).
 *
 * The browser and shell stores are driven in a browser and on a device; what the interface
 * promises — a record per download keyed under its account, progress on the way in, nothing kept
 * after a cancel, a stable local URL, the free-space reading — is asserted here against the fake
 * the manager's tests run on, so a change to the contract shows up in one place.
 */
function draft(userId: string, recordingId: string): DownloadDraft {
  return {
    key: `${userId}:${recordingId}`,
    userId,
    recordingId,
    title: `Teaching ${recordingId}`,
    seriesId: null,
    seriesTitle: null,
    recordedAt: '2026-08-16',
    bytes: 0,
    contentType: '',
    recording: {
      id: recordingId,
      title: `Teaching ${recordingId}`,
      recordedAt: '2026-08-16',
      publishedAt: '2026-08-17T00:00:00.000Z',
      description: null,
      summary: null,
      series: null,
      hasScripture: false,
      tags: [],
    },
    chapters: [],
    scripture: [],
    notes: [],
    progress: null,
  };
}

const source = { url: 'https://store.test/one', bytes: 8, contentType: 'audio/mpeg' };

describe('the download store', () => {
  it('fetches into a record under the account, reporting progress on the way', async () => {
    const store = createMemoryDownloadStore({ steps: 4 });
    const seen: number[] = [];
    const record = await store.fetchInto(draft('u1', 'r1'), source, (loaded) => seen.push(loaded), new AbortController().signal);
    expect(seen).toEqual([2, 4, 6, 8]);
    expect(record.bytes).toBe(8);
    expect(record.location).toEqual({ kind: 'idb' });
    expect(await store.get('u1', 'r1')).toEqual(record);
    expect(await store.get('u2', 'r1')).toBeNull();
    expect((await store.list('u1')).map((one) => one.recordingId)).toEqual(['r1']);
    expect(await store.list('u2')).toEqual([]);
  });

  it('keeps nothing of a cancelled fetch', async () => {
    const store = createMemoryDownloadStore({ steps: 4 });
    const controller = new AbortController();
    const fetching = store.fetchInto(
      draft('u1', 'r1'),
      source,
      (loaded) => {
        if (loaded >= 4) controller.abort();
      },
      controller.signal,
    );
    await expect(fetching).rejects.toBeInstanceOf(DownloadCancelled);
    expect(await store.get('u1', 'r1')).toBeNull();
    expect(await store.list('u1')).toEqual([]);
  });

  it('answers a local URL while the bytes are there and null once removed', async () => {
    const store = createMemoryDownloadStore();
    const record = await store.fetchInto(draft('u1', 'r1'), source, vi.fn(), new AbortController().signal);
    expect(await store.localUrl(record)).toBe('memory://u1:r1');
    await store.remove('u1', 'r1');
    expect(await store.localUrl(record)).toBeNull();
    expect(await store.get('u1', 'r1')).toBeNull();
  });

  it('updates metadata in place without touching the bytes', async () => {
    const store = createMemoryDownloadStore();
    const record = await store.fetchInto(draft('u1', 'r1'), source, vi.fn(), new AbortController().signal);
    await store.update({ ...record, progress: { positionMs: 5_000, updatedAt: null, completedAt: null } });
    expect((await store.get('u1', 'r1'))?.progress?.positionMs).toBe(5_000);
    expect(store.media.get('u1:r1')?.byteLength).toBe(8);
  });

  it('reports free space, or null where the check does not apply', async () => {
    const store = createMemoryDownloadStore({ freeBytes: 1_000 });
    expect(await store.freeBytes()).toBe(1_000);
    store.setFreeBytes(null);
    expect(await store.freeBytes()).toBeNull();
  });
});
