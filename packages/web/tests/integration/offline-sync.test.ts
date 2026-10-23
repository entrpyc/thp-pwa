import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  ROLE,
  SYNC_PATH,
  recordingDownloadPath,
  recordingNotesPath,
  recordingProgressPath,
  seriesDownloadPath,
  type DownloadGrantPayload,
  type NotesPayload,
  type PlaybackProgressPayload,
  type SeriesDownloadPayload,
  type SyncPayload,
  type SyncRequest,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  insertSeries,
  setRecordingPublication,
  setRecordingSeries,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, signIn, type TestAccount } from '../support/accounts';
import { uploadTestAudio } from '../support/audio';

/**
 * **The three offline routes** (docs/project/prd.md 3.18.5, 3.18.6, 3.18.12, 3.18.14, 3.18.15;
 * project tdd 5.3).
 *
 * The download grant carries the object's real size from the bucket; the series route sizes the
 * published recordings only; and the sync route applies an outbox through the live services —
 * positions land, notes land, a refused note answers as the live route would, a replayed client
 * id applies nothing twice, and a download of an unpublished teaching is named for removal.
 */
const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const TEACHING_SECONDS = 2;

let handle: DatabaseHandle;
let member: TestAccount;
let cookie: string;
let strangerCookie: string;
let seriesId: string;
let publishedId: string;
let secondId: string;
let draftId: string;
let publishedBytes: number;

async function api<T>(path: string, init: RequestInit = {}, who: string = cookie): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    ...init,
    headers: { accept: 'application/json', 'content-type': 'application/json', cookie: who, ...(init.headers ?? {}) },
  });
  return { status: response.status, body: (await response.json()) as T };
}

function entryId(): string {
  return crypto.randomUUID();
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
  member = await createAccount(databaseUrl, ROLE.member, 'offline-member');
  const signedIn = await signIn(baseUrl, member.email, member.password);
  if (signedIn.cookie === null) throw new Error('could not sign the member in');
  cookie = signedIn.cookie;
  const stranger = await createAccount(databaseUrl, ROLE.member, 'offline-stranger');
  const strangerIn = await signIn(baseUrl, stranger.email, stranger.password);
  if (strangerIn.cookie === null) throw new Error('could not sign the stranger in');
  strangerCookie = strangerIn.cookie;

  const upload = await uploadTestAudio(settings, TEACHING_SECONDS);
  publishedBytes = upload.bytes;
  seriesId = (await insertSeries({ title: `Offline study ${RUN}`, description: null }, handle)).id;

  publishedId = (await insertRecording({ originalMediaKey: upload.key, title: `Offline one ${RUN}`, recordedAt: '2026-03-03' }, handle)).id;
  const second = await uploadTestAudio(settings, TEACHING_SECONDS);
  secondId = (await insertRecording({ originalMediaKey: second.key, title: `Offline two ${RUN}`, recordedAt: '2026-02-02' }, handle)).id;
  draftId = (await insertRecording({ originalMediaKey: `originals/offline-draft-${RUN}.mp3`, title: `Offline draft ${RUN}`, recordedAt: '2026-01-01' }, handle)).id;
  for (const id of [publishedId, secondId, draftId]) await setRecordingSeries(id, seriesId, handle);
  await setRecordingPublication(publishedId, new Date(), handle);
  await setRecordingPublication(secondId, new Date(), handle);
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

describe('the download grant', () => {
  it('answers a signed URL with the object’s size, for a published teaching', async () => {
    const { status, body } = await api<DownloadGrantPayload>(recordingDownloadPath(publishedId));
    expect(status).toBe(200);
    expect(body.bytes).toBe(publishedBytes);
    expect(body.contentType).toContain('audio');
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    const fetched = await fetch(body.url);
    expect(fetched.status).toBe(200);
    expect(Number(fetched.headers.get('content-length'))).toBe(publishedBytes);
  });

  it('refuses an unpublished teaching as not found', async () => {
    const { status, body } = await api<{ error: { code: string } }>(recordingDownloadPath(draftId));
    expect(status).toBe(404);
    expect(body.error.code).toBe('not_found');
  });
});

describe('the series sizes', () => {
  it('names the published recordings with their bytes, newest recorded first', async () => {
    const { status, body } = await api<SeriesDownloadPayload>(seriesDownloadPath(seriesId));
    expect(status).toBe(200);
    expect(body.recordings.map((one) => one.id)).toEqual([publishedId, secondId]);
    expect(body.recordings[0]?.bytes).toBe(publishedBytes);
    expect(body.recordings[0]?.recordedAt).toBe('2026-03-03');
  });
});

describe('the sync', () => {
  it('applies a position and a note through the live services, and names revoked downloads', async () => {
    const positionId = entryId();
    const noteId = entryId();
    const request: SyncRequest = {
      entries: [
        { clientId: positionId, kind: 'progress', recordingId: publishedId, at: new Date().toISOString(), body: { positionMs: 42_000 } },
        { clientId: noteId, kind: 'note', recordingId: publishedId, at: new Date().toISOString(), body: { text: `Offline note ${RUN}`, visibility: 'private', timestampMs: 42_000 } },
      ],
      downloaded: [publishedId, draftId, 'not-a-recording'],
    };
    const { status, body } = await api<SyncPayload>(SYNC_PATH, { method: 'POST', body: JSON.stringify(request) });
    expect(status).toBe(200);
    expect(body.results).toEqual([
      { clientId: positionId, status: 'applied', code: null, message: null, note: null },
      expect.objectContaining({ clientId: noteId, status: 'applied', note: expect.objectContaining({ text: `Offline note ${RUN}`, mine: true }) }),
    ]);
    expect(body.revoked).toEqual([draftId, 'not-a-recording']);

    const progress = await api<PlaybackProgressPayload>(recordingProgressPath(publishedId));
    expect(progress.body.positionMs).toBe(42_000);
    const notes = await api<NotesPayload>(recordingNotesPath(publishedId));
    expect(notes.body.notes.map((one) => one.text)).toContain(`Offline note ${RUN}`);

    // The same outbox again — the phone never saw the answer — applies nothing twice.
    const replay = await api<SyncPayload>(SYNC_PATH, { method: 'POST', body: JSON.stringify(request) });
    expect(replay.body.results.map((one) => one.status)).toEqual(['duplicate', 'duplicate']);
    const again = await api<NotesPayload>(recordingNotesPath(publishedId));
    expect(again.body.notes.filter((one) => one.text === `Offline note ${RUN}`)).toHaveLength(1);
  });

  it('answers a refusal per entry as the live route would, without failing the request', async () => {
    const tooNear = entryId();
    const gone = entryId();
    const empty = entryId();
    const { status, body } = await api<SyncPayload>(SYNC_PATH, {
      method: 'POST',
      body: JSON.stringify({
        entries: [
          { clientId: tooNear, kind: 'progress', recordingId: publishedId, at: new Date().toISOString(), body: { positionMs: 1_000 } },
          { clientId: gone, kind: 'note', recordingId: draftId, at: new Date().toISOString(), body: { text: 'On a draft', visibility: 'private', timestampMs: 1_000 } },
          { clientId: empty, kind: 'note', recordingId: publishedId, at: new Date().toISOString(), body: { text: '   ', visibility: 'private', timestampMs: 1_000 } },
        ],
        downloaded: [],
      } satisfies SyncRequest),
    });
    expect(status).toBe(200);
    expect(body.results.map((one) => [one.status, one.code])).toEqual([
      ['refused', 'invalid_input'],
      ['refused', 'not_found'],
      ['refused', 'invalid_input'],
    ]);
    expect(body.results[1]?.message).toBeTruthy();
  });

  it('is per account: another member’s receipt does not stand in for mine', async () => {
    const shared = entryId();
    const entry = { clientId: shared, kind: 'progress' as const, recordingId: publishedId, at: new Date().toISOString(), body: { positionMs: 60_000 } };
    const mine = await api<SyncPayload>(SYNC_PATH, { method: 'POST', body: JSON.stringify({ entries: [entry], downloaded: [] }) });
    const theirs = await api<SyncPayload>(SYNC_PATH, { method: 'POST', body: JSON.stringify({ entries: [entry], downloaded: [] }) }, strangerCookie);
    expect(mine.body.results[0]?.status).toBe('applied');
    expect(theirs.body.results[0]?.status).toBe('applied');
  });

  it('refuses a malformed outbox outright', async () => {
    const bad = await api<{ error: { code: string } }>(SYNC_PATH, { method: 'POST', body: JSON.stringify({ entries: [{ clientId: 'nope' }], downloaded: [] }) });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_input');
    const twice = entryId();
    const dup = await api<{ error: { code: string } }>(SYNC_PATH, {
      method: 'POST',
      body: JSON.stringify({
        entries: [
          { clientId: twice, kind: 'progress', recordingId: publishedId, at: new Date().toISOString(), body: { positionMs: 9_000 } },
          { clientId: twice, kind: 'progress', recordingId: publishedId, at: new Date().toISOString(), body: { positionMs: 9_000 } },
        ],
        downloaded: [],
      }),
    });
    expect(dup.status).toBe(400);
  });

  it('refuses an anonymous caller', async () => {
    const response = await fetch(`${baseUrl}${API_PREFIX}${SYNC_PATH}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ entries: [], downloaded: [] }),
    });
    expect(response.status).toBe(401);
  });
});
