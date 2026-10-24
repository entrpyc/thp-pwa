import { describe, expect, it } from 'vitest';
import { memberRecordingPath, memberSeriesPath, recordingNotesPath, scopedToChapter } from '@thp/shared';
import {
  apiRoute,
  offlineAnswer,
  offlineNoteWrite,
  positionFor,
  type Snapshot,
} from '@/client/offline/offline-api';
import type { DownloadRecord, OutboxRecord } from '@/client/offline/schema';
import {
  ACTIVE_USER_KEY,
  BY_USER_INDEX,
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_STORES,
} from '@/client/offline/schema';

/**
 * **The API answered from the device** (docs/project/prd.md 3.18.3, 3.18.4, 3.18.13, 3.18.15):
 * which paths are answerable, what each answer holds, and what a note written offline becomes.
 * Pure functions over a snapshot, so no database is involved; the IndexedDB wiring is driven by
 * the browser suite.
 */
function download(recordingId: string, seriesId: string | null, recordedAt: string, userId = 'u1'): DownloadRecord {
  return {
    key: `${userId}:${recordingId}`,
    userId,
    recordingId,
    title: `Teaching ${recordingId}`,
    seriesId,
    seriesTitle: seriesId === null ? null : 'Study',
    recordedAt,
    bytes: 8,
    contentType: 'audio/mpeg',
    downloadedAt: '2026-10-23T09:00:00.000Z',
    location: { kind: 'idb' },
    recording: {
      id: recordingId,
      title: `Teaching ${recordingId}`,
      recordedAt,
      publishedAt: '2026-10-01T00:00:00.000Z',
      description: null,
      summary: null,
      series: seriesId === null ? null : { id: seriesId, title: 'Study', artworkUrl: null },
      hasScripture: false,
      hasMindMap: false,
      tags: [],
    },
    chapters: [
      { id: 'c1', position: 1, startMs: 0, endMs: 60_000, title: 'One', summary: '', editedByAdmin: false },
      { id: 'c2', position: 2, startMs: 60_000, endMs: 120_000, title: 'Two', summary: '', editedByAdmin: false },
    ],
    scripture: [],
    notes: [
      {
        id: 'n1',
        timestampMs: 70_000,
        authorId: 'u9',
        authorDisplayName: 'Someone',
        authorAvatarUrl: null,
        visibility: 'public',
        mine: false,
        text: 'Stored',
        createdAt: '2026-10-20T00:00:00.000Z',
        deleted: false,
        pinned: false,
        replies: [],
        reactions: [],
        myReaction: null,
        images: [],
      },
    ],
    progress: { positionMs: 30_000, updatedAt: '2026-10-20T00:00:00.000Z', completedAt: null },
  };
}

const outbox: OutboxRecord[] = [
  { clientId: 'p1', userId: 'u1', kind: 'progress', recordingId: 'new', at: '2026-10-23T10:00:00.000Z', body: { positionMs: 45_000 } },
  { clientId: 'n2', userId: 'u1', kind: 'note', recordingId: 'new', at: '2026-10-23T10:01:00.000Z', body: { text: 'Pending', visibility: 'private', timestampMs: 5_000 } },
];

const snapshot: Snapshot = {
  userId: 'u1',
  downloads: [download('old', 's1', '2026-01-01'), download('new', 's1', '2026-03-03'), download('loose', null, '2026-02-02'), download('other', null, '2026-04-04', 'u2')],
  outbox,
  session: {
    user: { id: 'u1', email: 'ada@example.test', displayName: 'Ada', role: 'member', preferredPlaybackSpeed: 1, analyticsOptedOut: false, avatarUrl: null },
  },
};

describe('the names the worker shares', () => {
  it('are stable, because the page and the worker open the same database', () => {
    expect(OFFLINE_DB_NAME).toBe('thp-offline');
    // 2 since pictures on notes (3.12.22) added the `noteImages` store.
    expect(OFFLINE_DB_VERSION).toBe(2);
    expect(BY_USER_INDEX).toBe('byUser');
    expect(ACTIVE_USER_KEY).toBe('activeUser');
    expect(Object.values(OFFLINE_STORES)).toEqual(['downloads', 'media', 'outbox', 'meta', 'noteImages']);
  });
});

describe('which reads are answerable', () => {
  it('recognises the member surface’s reads and nothing else', () => {
    expect(apiRoute('/recordings?surface=library')).toEqual({ name: 'library' });
    expect(apiRoute('/recordings')).toBeNull();
    expect(apiRoute(memberSeriesPath('s1'))).toEqual({ name: 'series', id: 's1' });
    expect(apiRoute(memberRecordingPath('r1'))).toEqual({ name: 'recording', id: 'r1', chapter: null });
    expect(apiRoute(scopedToChapter(recordingNotesPath('r1'), 'c2'))).toEqual({ name: 'notes', id: 'r1', chapter: 'c2' });
    expect(apiRoute('/auth/session')).toEqual({ name: 'session' });
    expect(apiRoute('/notifications')).toBeNull();
    expect(apiRoute('/recordings/r1/playback')).toBeNull();
  });
});

describe('what is answered offline', () => {
  it('lists only this member’s downloads, newest recorded first (3.18.13)', () => {
    const answer = offlineAnswer({ name: 'library' }, snapshot);
    expect((answer?.body as { recordings: { id: string }[] }).recordings.map((one) => one.id)).toEqual(['new', 'loose', 'old']);
  });

  it('derives the series from what is held', () => {
    const list = offlineAnswer({ name: 'series-list' }, snapshot);
    expect((list?.body as { series: unknown[] }).series).toEqual([
      expect.objectContaining({ id: 's1', title: 'Study', recordingCount: 2, firstRecordedAt: '2026-01-01', lastRecordedAt: '2026-03-03' }),
    ]);
    const one = offlineAnswer({ name: 'series', id: 's1' }, snapshot);
    expect((one?.body as { recordings: unknown[] }).recordings).toEqual([
      expect.objectContaining({ id: 'new', positionMs: 45_000 }),
      expect.objectContaining({ id: 'old', positionMs: 30_000 }),
    ]);
    expect(offlineAnswer({ name: 'series', id: 'missing' }, snapshot)).toBeNull();
  });

  it('hands back the chapters, scripture and notes stored with a teaching, plus pending notes', () => {
    expect((offlineAnswer({ name: 'chapters', id: 'new', chapter: null }, snapshot)?.body as { chapters: unknown[] }).chapters).toHaveLength(2);
    expect((offlineAnswer({ name: 'scripture', id: 'new', chapter: null }, snapshot)?.body as { references: unknown[] }).references).toEqual([]);
    const notes = (offlineAnswer({ name: 'notes', id: 'new', chapter: null }, snapshot)?.body as { notes: { id: string; mine: boolean; authorDisplayName: string; text: string }[] }).notes;
    expect(notes.map((one) => one.id)).toEqual(['pending:n2', 'n1']);
    expect(notes[0]).toMatchObject({ mine: true, authorDisplayName: 'Ada', text: 'Pending' });
    const scoped = (offlineAnswer({ name: 'notes', id: 'new', chapter: 'c2' }, snapshot)?.body as { notes: { id: string }[] }).notes;
    expect(scoped.map((one) => one.id)).toEqual(['n1']);
    expect(offlineAnswer({ name: 'notes', id: 'other', chapter: null }, snapshot)).toBeNull();
  });

  it('answers the position from the outbox ahead of the stored one', () => {
    expect(positionFor(download('new', 's1', '2026-03-03'), outbox)).toBe(45_000);
    expect(positionFor(download('old', 's1', '2026-01-01'), outbox)).toBe(30_000);
    expect((offlineAnswer({ name: 'progress', id: 'new', chapter: null }, snapshot)?.body as { positionMs: number }).positionMs).toBe(45_000);
  });

  it('answers the session only when one was kept, and nothing for a teaching not held', () => {
    expect(offlineAnswer({ name: 'session' }, snapshot)?.body).toEqual(snapshot.session);
    expect(offlineAnswer({ name: 'session' }, { ...snapshot, session: null })).toBeNull();
    expect(offlineAnswer({ name: 'recording', id: 'nope', chapter: null }, snapshot)).toBeNull();
  });
});

describe('a note written offline', () => {
  it('becomes an outbox entry and a 201 with the pending copy', () => {
    const result = offlineNoteWrite('new', { text: 'Hello', visibility: 'public', timestampMs: 9_000 }, snapshot);
    expect('entry' in result).toBe(true);
    if (!('entry' in result)) return;
    expect(result.entry).toMatchObject({ userId: 'u1', kind: 'note', recordingId: 'new', body: { text: 'Hello', visibility: 'public', timestampMs: 9_000 } });
    expect(result.answer.status).toBe(201);
    expect(result.answer.body).toMatchObject({ note: { text: 'Hello', mine: true, id: `pending:${result.entry.clientId}` } });
  });

  it('refuses a reply, a teaching not held, and a malformed body — as the API would, with 503', () => {
    for (const [recordingId, body] of [
      ['new', { text: 'Reply', parentId: 'n1' }],
      ['other', { text: 'Not mine', visibility: 'public', timestampMs: 1 }],
      ['new', { visibility: 'public' }],
    ] as const) {
      const result = offlineNoteWrite(recordingId, body, snapshot);
      expect('entry' in result).toBe(false);
      expect(result.answer.status).toBe(503);
      expect(result.answer.body).toMatchObject({ error: { code: 'service_unavailable' } });
    }
  });
});
