import { describe, expect, it, vi } from 'vitest';
import {
  SYNC_PATH,
  memberRecordingPath,
  recordingChaptersPath,
  recordingDownloadPath,
  recordingNotesPath,
  recordingProgressPath,
  seriesDownloadPath,
  type SyncPayload,
} from '@thp/shared';
import { createOfflineManager, type JsonFetch, type OfflineManagerOptions } from '@/client/offline/manager';
import { FREE_SPACE_RESERVE_BYTES } from '@/client/offline/queue';
import type { OutboxRecord } from '@/client/offline/schema';
import { createMemoryDownloadStore } from '@/client/offline/store';

/**
 * **The manager over the fake store** (docs/project/prd.md 3.18.7–3.18.12, 3.18.14, 3.18.17).
 *
 * What the controls read: that a download runs through the grant, the four payloads and the
 * store; that a series is sized up and refused before anything is fetched; that the outbox is
 * flushed and the answer applied — settled entries leave, a refused note becomes a notice, a
 * revoked download is removed.
 */
const MB = 1024 * 1024;

function recordingPayload(id: string, seriesId: string | null = null) {
  return {
    recording: {
      id,
      title: `Teaching ${id}`,
      recordedAt: '2026-08-16',
      publishedAt: '2026-08-17T00:00:00.000Z',
      description: null,
      summary: null,
      series: seriesId === null ? null : { id: seriesId, title: 'Study', artworkUrl: null },
      hasScripture: false,
      tags: [],
    },
  };
}

function fakeApi(overrides: Record<string, unknown> = {}, calls: string[] = []): JsonFetch {
  return async <T>(path: string, init?: RequestInit): Promise<T> => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path in overrides) {
      const answer = overrides[path];
      if (answer instanceof Error) throw answer;
      return (typeof answer === 'function' ? answer(init) : answer) as T;
    }
    const grant = /^\/recordings\/([^/]+)\/download$/.exec(path);
    if (grant) return { url: `https://store.test/${grant[1]}`, expiresAt: '2099-01-01T00:00:00.000Z', bytes: 8, contentType: 'audio/mpeg' } as T;
    const recording = /^\/recordings\/([^/]+)\?surface=library$/.exec(path);
    if (recording) return recordingPayload(recording[1]!) as T;
    if (path.endsWith('/chapters')) return { chapters: [] } as T;
    if (path.endsWith('/notes')) return { notes: [] } as T;
    if (path.endsWith('/progress')) return { positionMs: null, updatedAt: null, completedAt: null } as T;
    throw new Error(`unexpected ${path}`);
  };
}

function fakeOutbox(records: OutboxRecord[]): NonNullable<OfflineManagerOptions['outbox']> {
  return {
    async list(userId) {
      return records.filter((one) => one.userId === userId);
    },
    async count(userId) {
      return records.filter((one) => one.userId === userId).length;
    },
    async remove(clientIds) {
      for (const id of clientIds) {
        const index = records.findIndex((one) => one.clientId === id);
        if (index >= 0) records.splice(index, 1);
      }
    },
    async appendProgress(userId, recordingId, body) {
      records.push({ clientId: `p-${records.length}`, userId, kind: 'progress', recordingId, at: new Date().toISOString(), body });
    },
  };
}

async function settled(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((done) => setTimeout(done, 0));
}

describe('downloading one teaching', () => {
  it('asks for the grant and the four payloads, stores the bytes, and warms the pages', async () => {
    const store = createMemoryDownloadStore();
    const calls: string[] = [];
    const warm = vi.fn();
    const manager = createOfflineManager({
      store,
      fetchJson: fakeApi({ [memberRecordingPath('r1')]: recordingPayload('r1', 's1') }, calls),
      outbox: fakeOutbox([]),
      rememberActiveUser: async () => undefined,
      warm,
      isOnline: () => true,
    });
    await manager.activate('u1');
    manager.download('r1', 'Teaching r1');
    await settled();

    expect(calls).toContain(`GET ${recordingDownloadPath('r1')}`);
    expect(calls).toContain(`GET ${recordingChaptersPath('r1')}`);
    expect(calls).toContain(`GET ${recordingNotesPath('r1')}`);
    expect(calls).toContain(`GET ${recordingProgressPath('r1')}`);
    const snapshot = manager.getSnapshot();
    expect(snapshot.downloads.map((one) => one.recordingId)).toEqual(['r1']);
    expect(snapshot.downloads[0]?.seriesId).toBe('s1');
    expect(snapshot.totalBytes).toBe(8);
    expect(snapshot.queue.items[0]?.status).toBe('done');
    expect(manager.isDownloaded('r1')).toBe(true);
    expect(warm).toHaveBeenCalledWith(expect.arrayContaining(['/recordings/r1', '/series/s1']));
    expect(await manager.localSourceFor('r1')).toBe('memory://u1:r1');
  });

  it('refuses before fetching when the grant says it would not fit', async () => {
    const store = createMemoryDownloadStore({ freeBytes: FREE_SPACE_RESERVE_BYTES + 4 });
    const calls: string[] = [];
    const manager = createOfflineManager({
      store,
      fetchJson: fakeApi({}, calls),
      outbox: fakeOutbox([]),
      rememberActiveUser: async () => undefined,
      warm: vi.fn(),
      isOnline: () => true,
    });
    await manager.activate('u1');
    manager.download('r1', 'Teaching r1');
    await settled();
    const item = manager.getSnapshot().queue.items[0];
    expect(item?.status).toBe('failed');
    expect(item?.failure).toContain('Not enough space');
    expect(calls).not.toContain(`GET ${memberRecordingPath('r1')}`);
    expect(store.records.size).toBe(0);
  });

  it('reports a refused grant as the failure sentence and keeps nothing', async () => {
    const store = createMemoryDownloadStore();
    const manager = createOfflineManager({
      store,
      fetchJson: fakeApi({ [recordingDownloadPath('gone')]: new Error('There is no such teaching.') }),
      outbox: fakeOutbox([]),
      rememberActiveUser: async () => undefined,
      warm: vi.fn(),
      isOnline: () => true,
    });
    await manager.activate('u1');
    manager.download('gone', 'Gone');
    await settled();
    expect(manager.getSnapshot().queue.items[0]).toMatchObject({ status: 'failed', failure: 'There is no such teaching.' });
    expect(manager.getSnapshot().downloads).toEqual([]);
  });
});

describe('"Download all"', () => {
  it('sizes the series up against what is held and what is free, then queues what was confirmed', async () => {
    const store = createMemoryDownloadStore({ freeBytes: 50 * MB + FREE_SPACE_RESERVE_BYTES });
    const manager = createOfflineManager({
      store,
      fetchJson: fakeApi({
        [seriesDownloadPath('s1')]: {
          recordings: [
            { id: 'new', title: 'New', recordedAt: '2026-03-03', bytes: 30 * MB },
            { id: 'mid', title: 'Mid', recordedAt: '2026-02-02', bytes: 30 * MB },
            { id: 'old', title: 'Old', recordedAt: '2026-01-01', bytes: 30 * MB },
          ],
        },
      }),
      outbox: fakeOutbox([]),
      rememberActiveUser: async () => undefined,
      warm: vi.fn(),
      isOnline: () => true,
    });
    await manager.activate('u1');
    const plan = await manager.planSeries('s1');
    expect(plan.fits).toBe(false);
    expect(plan.neededBytes).toBe(90 * MB);
    expect(plan.offered.map((one) => one.id)).toEqual(['new']);

    manager.downloadMany(plan.offered.map((one) => ({ id: one.id, title: one.title, bytes: one.bytes })));
    expect(manager.getSnapshot().queue.items.map((one) => one.recordingId)).toEqual(['new']);
    expect(manager.getSnapshot().overall.remaining).toBe(1);
  });
});

describe('the flush', () => {
  it('sends the outbox and the held ids, settles what was answered, and removes what was revoked', async () => {
    const store = createMemoryDownloadStore();
    // Written after activation, because activating flushes whatever the outbox already holds.
    const records: OutboxRecord[] = [];
    let sentBody: unknown = null;
    const manager = createOfflineManager({
      store,
      fetchJson: fakeApi({
        [SYNC_PATH]: (init?: RequestInit) => {
          sentBody = JSON.parse(String(init?.body));
          const payload: SyncPayload = {
            results: [
              { clientId: 'p1', status: 'applied', code: null, message: null, note: null },
              { clientId: 'n1', status: 'refused', code: 'invalid_input', message: 'That word is not allowed.', note: null },
            ],
            revoked: ['r2'],
            syncedAt: '2026-10-23T10:05:00.000Z',
          };
          return payload;
        },
      }),
      outbox: fakeOutbox(records),
      rememberActiveUser: async () => undefined,
      warm: vi.fn(),
      isOnline: () => true,
    });
    await manager.activate('u1');
    manager.download('r1', 'One');
    manager.download('r2', 'Two');
    await settled();
    expect(manager.getSnapshot().downloads).toHaveLength(2);
    records.push(
      { clientId: 'p1', userId: 'u1', kind: 'progress', recordingId: 'r1', at: '2026-10-23T10:00:00.000Z', body: { positionMs: 9_000 } },
      { clientId: 'n1', userId: 'u1', kind: 'note', recordingId: 'r1', at: '2026-10-23T10:01:00.000Z', body: { text: 'Hello', visibility: 'public', timestampMs: 9_000 } },
    );
    await manager.reload();
    expect(manager.getSnapshot().pending).toBe(2);

    await manager.flush();

    expect(sentBody).toMatchObject({ downloaded: expect.arrayContaining(['r1', 'r2']) });
    expect((sentBody as { entries: unknown[] }).entries).toHaveLength(2);
    expect(records).toEqual([]);
    const snapshot = manager.getSnapshot();
    expect(snapshot.pending).toBe(0);
    expect(snapshot.downloads.map((one) => one.recordingId)).toEqual(['r1']);
    expect(snapshot.notices.map((one) => one.text)).toEqual([
      expect.stringContaining('That word is not allowed.'),
      expect.stringContaining('“Teaching r2” is no longer available'),
    ]);
    manager.dismissNotice(snapshot.notices[0]!.id);
    expect(manager.getSnapshot().notices).toHaveLength(1);
  });

  it('keeps the outbox when the server cannot be reached, and does nothing offline', async () => {
    const records: OutboxRecord[] = [
      { clientId: 'p1', userId: 'u1', kind: 'progress', recordingId: 'r1', at: '2026-10-23T10:00:00.000Z', body: { positionMs: 9_000 } },
    ];
    let online = false;
    const calls: string[] = [];
    const manager = createOfflineManager({
      store: createMemoryDownloadStore(),
      fetchJson: fakeApi({ [SYNC_PATH]: new Error('network') }, calls),
      outbox: fakeOutbox(records),
      rememberActiveUser: async () => undefined,
      warm: vi.fn(),
      isOnline: () => online,
    });
    await manager.activate('u1');
    await manager.flush();
    expect(calls).not.toContain(`POST ${SYNC_PATH}`);

    online = true;
    await manager.flush();
    expect(calls).toContain(`POST ${SYNC_PATH}`);
    expect(records).toHaveLength(1);
    expect(manager.getSnapshot().pending).toBe(1);
  });

  it('keeps a position the player could not send', async () => {
    const records: OutboxRecord[] = [];
    const manager = createOfflineManager({
      store: createMemoryDownloadStore(),
      fetchJson: fakeApi(),
      outbox: fakeOutbox(records),
      rememberActiveUser: async () => undefined,
      warm: vi.fn(),
      isOnline: () => false,
    });
    await manager.activate('u1');
    await manager.keepProgress('r1', { positionMs: 42_000 });
    expect(records).toMatchObject([{ kind: 'progress', recordingId: 'r1', body: { positionMs: 42_000 } }]);
    expect(manager.getSnapshot().pending).toBe(1);
  });
});
