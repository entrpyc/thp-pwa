import { describe, expect, it } from 'vitest';
import {
  FLOW_QUESTION_BANK_PATH,
  FLOW_SESSIONS_PATH,
  FLOW_TEACHINGS_PATH,
  HIGHLIGHTS_PATH,
  NOTE_FOLDERS_PATH,
  NOTIFICATIONS_PATH,
  PLAYBACK_SPEED_PATH,
  PUSH_PREFERENCES_PATH,
  SOS_PATH,
  flowSessionPath,
  sosPath,
  type FlowQuestionBankPayload,
  type FlowSessionView,
  type FlowSessionsPayload,
  type FlowTeachingsPayload,
  type HighlightListPayload,
  type NoteFoldersPayload,
  type NoteView,
  type NotificationListPayload,
  type PushPreferencesPayload,
  type SosListPayload,
  type SosSignalDetailView,
} from '@thp/shared';
import { isKeptRead, offlineAction, type Outcome, type World } from '@/client/offline/offline-actions';
import type { DownloadRecord } from '@/client/offline/schema';

/**
 * **What a member can do offline, decided without a database** ([3.18.18](docs/project/prd.md)).
 *
 * Each action is a pure function over the device's copies. What is asserted for each is the three
 * things the queue promises: the copy the screen reads is changed the way the server would change
 * it, the answer has the shape the screen renders, and what is queued says enough to be sent and —
 * for something created — to learn its real id afterwards.
 */

const NOW = '2026-11-11T10:00:00.000Z';

function note(id: string, over: Partial<NoteView> = {}): NoteView {
  return {
    id,
    timestampMs: 1_000,
    authorId: 'someone',
    authorDisplayName: 'Someone',
    authorAvatarUrl: null,
    visibility: 'public',
    mine: false,
    text: `note ${id}`,
    createdAt: '2026-11-01T00:00:00.000Z',
    deleted: false,
    pinned: false,
    replies: [],
    reactions: [],
    myReaction: null,
    images: [],
    ...over,
  };
}

function download(recordingId: string, notes: NoteView[]): DownloadRecord {
  return {
    key: `u1:${recordingId}`,
    userId: 'u1',
    recordingId,
    title: `Teaching ${recordingId}`,
    seriesId: null,
    seriesTitle: null,
    recordedAt: '2026-10-01',
    bytes: 8,
    contentType: 'audio/mpeg',
    downloadedAt: NOW,
    location: { kind: 'idb' },
    recording: {
      id: recordingId,
      title: `Teaching ${recordingId}`,
      recordedAt: '2026-10-01',
      description: null,
      series: null,
    } as unknown as DownloadRecord['recording'],
    chapters: [],
    scripture: [],
    notes,
    progress: null,
  };
}

interface Device {
  readonly world: World;
  readonly reads: Map<string, unknown>;
  readonly downloads: Map<string, DownloadRecord>;
  readonly temps: Set<string>;
  speed: number | null;
}

function device(reads: Record<string, unknown> = {}, downloads: DownloadRecord[] = []): Device {
  const held = new Map(Object.entries(reads));
  const kept = new Map(downloads.map((one) => [one.recordingId, one]));
  const temps = new Set<string>();
  let minted = 0;
  const state: Device = {
    reads: held,
    downloads: kept,
    temps,
    speed: null,
    world: {
      userId: 'u1',
      now: NOW,
      user: { id: 'u1', displayName: 'Ana', avatarUrl: null },
      mintId: () => {
        minted += 1;
        return `temp-${minted}`;
      },
      read: <T,>(path: string) => held.get(path) as T | undefined,
      paths: () => [...held.keys()],
      write: (path, body) => void held.set(path, body),
      downloads: () => [...kept.values()],
      putDownload: (record) => void kept.set(record.recordingId, record),
      setSpeed: (speed) => {
        state.speed = speed;
      },
      isQueuedTemp: (id) => temps.has(id),
    },
  };
  return state;
}

function done(outcome: Outcome | null): Extract<Outcome, { status: number; body: unknown }> & { refused?: undefined } {
  if (outcome === null) throw new Error('not an action the device keeps');
  if ('refused' in outcome) throw new Error(`refused: ${outcome.message}`);
  return outcome as never;
}

function refused(outcome: Outcome | null): { status: number; code: string; message: string } {
  if (outcome === null || !('refused' in outcome)) throw new Error('was not refused');
  return outcome;
}

describe('which writes the device keeps', () => {
  it('answers null for a write that is not on the table, so it fails as it always did', () => {
    const { world } = device();
    expect(offlineAction('POST', '/feedback', {}, world)).toBeNull();
    expect(offlineAction('PUT', '/users/me/avatar', {}, world)).toBeNull();
    expect(offlineAction('DELETE', '/auth/session', null, world)).toBeNull();
  });

  it('keeps a copy of exactly the reads those screens make', () => {
    for (const path of [
      '/users/me/notes',
      NOTE_FOLDERS_PATH,
      HIGHLIGHTS_PATH,
      SOS_PATH,
      `${SOS_PATH}?status=resolved`,
      sosPath('s1'),
      FLOW_TEACHINGS_PATH,
      FLOW_QUESTION_BANK_PATH,
      FLOW_SESSIONS_PATH,
      flowSessionPath('f1'),
      NOTIFICATIONS_PATH,
      `${NOTIFICATIONS_PATH}?before=n9`,
      PUSH_PREFERENCES_PATH,
    ]) {
      expect(isKeptRead(path), path).toBe(true);
    }
    expect(isKeptRead('/users/me')).toBe(false);
    expect(isKeptRead('/search?q=grace')).toBe(false);
    // A transcript is kept, so a line of a downloaded teaching can be highlighted offline.
    expect(isKeptRead('/recordings/r1/transcript')).toBe(true);
    expect(isKeptRead('/recordings/r1/mind-map')).toBe(false);
  });
});

describe('notes on a downloaded teaching', () => {
  it('a reply is drawn under its parent as the member’s own, and queued for that teaching', () => {
    const d = device({}, [download('r1', [note('n1')])]);
    const outcome = done(offlineAction('POST', '/recordings/r1/notes', { text: 'Amen', parentId: 'n1' }, d.world));
    const replies = d.downloads.get('r1')?.notes[0]?.replies ?? [];
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ text: 'Amen', mine: true, authorDisplayName: 'Ana', createdAt: NOW });
    expect(replies[0]?.id.startsWith('pending:')).toBe(true);
    expect(outcome.queue).toMatchObject({ label: 'A reply', recordingId: 'r1' });
  });

  it('a reply to a note that is not sent yet, or on a teaching not held, is refused rather than queued', () => {
    const d = device({}, [download('r1', [note('n1')])]);
    expect(refused(offlineAction('POST', '/recordings/r1/notes', { text: 'x', parentId: 'pending:abc' }, d.world)).message).toContain('not been sent yet');
    expect(refused(offlineAction('POST', '/recordings/r9/notes', { text: 'x', parentId: 'n1' }, d.world)).message).toContain('not downloaded');
  });

  it('an edit rewrites the text wherever the note is held; the last edit is the one sent', () => {
    const d = device(
      {
        [HIGHLIGHTS_PATH]: { highlights: [{ id: 'h1', kind: 'note', note: { id: 'n1', text: 'old' }, recording: { id: 'r1' } }] },
        '/users/me/notes': { entries: [{ note: note('n1', { mine: true }), recording: { id: 'r1' } }] },
      },
      [download('r1', [note('n1', { mine: true, text: 'old' })])],
    );
    const outcome = done(offlineAction('PATCH', '/notes/n1', { text: 'new' }, d.world));
    expect(d.downloads.get('r1')?.notes[0]?.text).toBe('new');
    expect((d.reads.get(HIGHLIGHTS_PATH) as HighlightListPayload).highlights[0]?.note?.text).toBe('new');
    expect((d.reads.get('/users/me/notes') as { entries: { note: NoteView }[] }).entries[0]?.note.text).toBe('new');
    expect(outcome.queue?.coalesce).toBe('note-edit:n1');
  });

  it('a delete leaves the tombstone the server answers, and takes the note off the member’s lists', () => {
    const d = device(
      { '/users/me/notes': { entries: [{ note: note('n1', { mine: true }), recording: { id: 'r1' } }] } },
      [download('r1', [note('n1', { mine: true, reactions: [{ emoji: '🙏', count: 2 }] })])],
    );
    done(offlineAction('DELETE', '/notes/n1', null, d.world));
    expect(d.downloads.get('r1')?.notes[0]).toMatchObject({ deleted: true, text: '', reactions: [], authorId: null });
    expect((d.reads.get('/users/me/notes') as { entries: unknown[] }).entries).toEqual([]);
    // Deleting it again is the server's own refusal, not a second queued delete.
    expect(refused(offlineAction('DELETE', '/notes/n1', null, d.world)).code).toBe('note_removed');
  });

  it('a reaction moves the counts as the server would: one per member, replaced or removed', () => {
    const d = device({}, [download('r1', [note('n1', { reactions: [{ emoji: '🙏', count: 2 }, { emoji: '❤️', count: 1 }], myReaction: '❤️' })])]);
    const put = done(offlineAction('PUT', '/notes/n1/reaction', { emoji: '🙏' }, d.world));
    expect(d.downloads.get('r1')?.notes[0]).toMatchObject({ myReaction: '🙏', reactions: [{ emoji: '🙏', count: 3 }] });
    expect(put.queue?.coalesce).toBe('note-reaction:n1');
    done(offlineAction('DELETE', '/notes/n1/reaction', null, d.world));
    expect(d.downloads.get('r1')?.notes[0]).toMatchObject({ myReaction: null, reactions: [{ emoji: '🙏', count: 2 }] });
  });
});

describe('note folders', () => {
  const held: NoteFoldersPayload = { folders: [{ id: 'f1', name: 'Prayer', noteIds: ['n1'], createdAt: '2026-10-01T00:00:00.000Z' }] };

  it('creates one under a device id, in name order, and says where the real id will be', () => {
    const d = device({ [NOTE_FOLDERS_PATH]: held });
    const outcome = done(offlineAction('POST', NOTE_FOLDERS_PATH, { name: '  Grace  ' }, d.world));
    const folders = (outcome.body as NoteFoldersPayload).folders;
    expect(folders.map((one) => one.name)).toEqual(['Grace', 'Prayer']);
    expect(outcome.queue?.creates).toEqual([{ temp: 'temp-1', at: 'folders[name=Grace].id' }]);
    expect(d.reads.get(NOTE_FOLDERS_PATH)).toEqual(outcome.body);
  });

  it('refuses a second folder of the same name with the server’s own code', () => {
    const d = device({ [NOTE_FOLDERS_PATH]: held });
    expect(refused(offlineAction('POST', NOTE_FOLDERS_PATH, { name: 'prayer' }, d.world))).toMatchObject({ status: 409, code: 'note_folder_exists' });
  });

  it('files a note by replacing its whole set, renames, and removes', () => {
    const d = device({ [NOTE_FOLDERS_PATH]: { folders: [...held.folders, { id: 'f2', name: 'Study', noteIds: [], createdAt: NOW }] } });
    done(offlineAction('PUT', '/notes/n1/folders', { folderIds: ['f2'] }, d.world));
    let folders = (d.reads.get(NOTE_FOLDERS_PATH) as NoteFoldersPayload).folders;
    expect(folders.find((one) => one.id === 'f1')?.noteIds).toEqual([]);
    expect(folders.find((one) => one.id === 'f2')?.noteIds).toEqual(['n1']);

    done(offlineAction('PATCH', `${NOTE_FOLDERS_PATH}/f2`, { name: 'Bible study' }, d.world));
    done(offlineAction('DELETE', `${NOTE_FOLDERS_PATH}/f1`, null, d.world));
    folders = (d.reads.get(NOTE_FOLDERS_PATH) as NoteFoldersPayload).folders;
    expect(folders.map((one) => one.name)).toEqual(['Bible study']);
  });

  it('a folder made offline and removed offline is cancelled, not sent and then deleted', () => {
    const d = device({ [NOTE_FOLDERS_PATH]: held });
    done(offlineAction('POST', NOTE_FOLDERS_PATH, { name: 'Grace' }, d.world));
    d.temps.add('temp-1');
    const outcome = done(offlineAction('DELETE', `${NOTE_FOLDERS_PATH}/temp-1`, null, d.world));
    expect(outcome.queue).toBeUndefined();
    expect(outcome.cancel).toBe('temp-1');
  });
});

describe('highlights', () => {
  it('adds a moment on a downloaded teaching to the front of the list, without the line the server finds', () => {
    const d = device({ [HIGHLIGHTS_PATH]: { highlights: [] } }, [download('r1', [])]);
    const outcome = done(offlineAction('POST', HIGHLIGHTS_PATH, { kind: 'segment', recordingId: 'r1', positionMs: 61_250.4 }, d.world));
    const list = (outcome.body as HighlightListPayload).highlights;
    expect(list[0]).toMatchObject({ id: 'temp-1', kind: 'segment', positionMs: 61_250, segment: null, note: null });
    expect(list[0]?.recording).toMatchObject({ id: 'r1', title: 'Teaching r1' });
    expect(outcome.queue?.creates).toEqual([{ temp: 'temp-1', at: 'highlights.0.id' }]);
  });

  it('snaps a moment to the transcript line under it when the transcript is on the device', () => {
    const d = device(
      {
        [HIGHLIGHTS_PATH]: { highlights: [] },
        '/recordings/r1/transcript': {
          transcript: {
            id: 't1',
            language: 'en',
            segments: [
              { id: 's1', startMs: 0, endMs: 5_000, text: 'First line.', speaker: null },
              { id: 's2', startMs: 5_000, endMs: 9_000, text: 'Second line.', speaker: null },
            ],
          },
        },
      },
      [download('r1', [])],
    );
    const outcome = done(offlineAction('POST', HIGHLIGHTS_PATH, { kind: 'segment', recordingId: 'r1', positionMs: 6_200 }, d.world));
    expect((outcome.body as HighlightListPayload).highlights[0]).toMatchObject({
      positionMs: 5_000,
      segment: { startMs: 5_000, endMs: 9_000, text: 'Second line.' },
    });
    // Another press inside the same line is the same highlight, as it is on the server.
    const again = done(offlineAction('POST', HIGHLIGHTS_PATH, { kind: 'segment', recordingId: 'r1', positionMs: 8_000 }, d.world));
    expect(again.queue).toBeUndefined();
  });

  it('adds a note with its words, and adding the same thing twice is not a second request', () => {
    const d = device({ [HIGHLIGHTS_PATH]: { highlights: [] } }, [download('r1', [note('n1', { text: 'Remember this' })])]);
    const first = done(offlineAction('POST', HIGHLIGHTS_PATH, { kind: 'note', noteId: 'n1' }, d.world));
    expect((first.body as HighlightListPayload).highlights[0]?.note).toEqual({ id: 'n1', text: 'Remember this' });
    const again = done(offlineAction('POST', HIGHLIGHTS_PATH, { kind: 'note', noteId: 'n1' }, d.world));
    expect(again.queue).toBeUndefined();
    expect((again.body as HighlightListPayload).highlights).toHaveLength(1);
  });

  it('refuses a teaching nothing on the device describes', () => {
    const d = device({ [HIGHLIGHTS_PATH]: { highlights: [] } });
    expect(refused(offlineAction('POST', HIGHLIGHTS_PATH, { kind: 'segment', recordingId: 'r9', positionMs: 5 }, d.world)).status).toBe(503);
  });

  it('removes one; one added offline is cancelled instead', () => {
    const d = device({ [HIGHLIGHTS_PATH]: { highlights: [{ id: 'h1' }, { id: 'temp-7' }] } });
    d.temps.add('temp-7');
    expect(done(offlineAction('DELETE', `${HIGHLIGHTS_PATH}/h1`, null, d.world)).queue?.label).toBe('Removing a highlight');
    const cancelled = done(offlineAction('DELETE', `${HIGHLIGHTS_PATH}/temp-7`, null, d.world));
    expect(cancelled.queue).toBeUndefined();
    expect(cancelled.cancel).toBe('temp-7');
    expect((d.reads.get(HIGHLIGHTS_PATH) as HighlightListPayload).highlights).toEqual([]);
  });
});

describe('prayer requests', () => {
  function signal(id: string, over: Partial<SosSignalDetailView> = {}): SosSignalDetailView {
    return {
      id,
      urgency: 'yellow',
      description: 'Please pray',
      author: { id: 'u2', displayName: 'Ben', avatarUrl: null },
      anonymous: false,
      mine: false,
      raisedAt: '2026-11-10T00:00:00.000Z',
      closedAt: null,
      closingNote: null,
      prayingCount: 1,
      praying: false,
      prayingAnonymously: false,
      replyCount: 0,
      prayingNames: ['Cy'],
      prayingAnonymousCount: 0,
      replies: [],
      ...over,
    };
  }
  const counts = { red: 0, orange: 0, yellow: 1, green: 0 };
  const boards = (rows: SosSignalDetailView[]) => ({
    [`${SOS_PATH}?status=open`]: { status: 'open', signals: rows, openCounts: counts } satisfies SosListPayload,
    [`${SOS_PATH}?status=resolved`]: { status: 'resolved', signals: [], openCounts: counts } satisfies SosListPayload,
  });

  it('raises one onto the open board by urgency, with a page of its own to open', () => {
    const d = device(boards([signal('s1')]));
    const outcome = done(offlineAction('POST', SOS_PATH, { urgency: 'red', description: ' Surgery tomorrow ', anonymous: false }, d.world));
    expect(outcome.status).toBe(201);
    const open = d.reads.get(`${SOS_PATH}?status=open`) as SosListPayload;
    expect(open.signals.map((one) => one.id)).toEqual(['temp-1', 's1']);
    expect(open.openCounts.red).toBe(1);
    expect((d.reads.get(sosPath('temp-1')) as { signal: SosSignalDetailView }).signal).toMatchObject({
      description: 'Surgery tomorrow',
      mine: true,
      author: { displayName: 'Ana' },
    });
    expect(outcome.queue?.creates).toEqual([{ temp: 'temp-1', at: 'signal.id' }]);
  });

  it('praying counts the member once, by name or anonymously, and un-praying takes them out', () => {
    const d = device({ ...boards([signal('s1')]), [sosPath('s1')]: { signal: signal('s1') } });
    const on = done(offlineAction('PUT', '/sos/s1/praying', { anonymous: false }, d.world));
    expect((on.body as { signal: SosSignalDetailView }).signal).toMatchObject({ praying: true, prayingCount: 2, prayingNames: ['Cy', 'Ana'] });
    expect((d.reads.get(`${SOS_PATH}?status=open`) as SosListPayload).signals[0]).toMatchObject({ praying: true, prayingCount: 2 });
    const anonymous = done(offlineAction('PUT', '/sos/s1/praying', { anonymous: true }, d.world));
    expect((anonymous.body as { signal: SosSignalDetailView }).signal).toMatchObject({ prayingCount: 2, prayingNames: ['Cy'], prayingAnonymousCount: 1 });
    const off = done(offlineAction('DELETE', '/sos/s1/praying', null, d.world));
    expect((off.body as { signal: SosSignalDetailView }).signal).toMatchObject({ praying: false, prayingCount: 1, prayingAnonymousCount: 0 });
    expect(off.queue?.coalesce).toBe('sos-praying:s1');
  });

  it('a reply is added and counted; closing moves the request from the open board to the resolved one', () => {
    const d = device({ ...boards([signal('s1', { mine: true })]), [sosPath('s1')]: { signal: signal('s1', { mine: true }) } });
    const replied = done(offlineAction('POST', '/sos/s1/replies', { text: 'Praying now' }, d.world));
    expect(replied.status).toBe(201);
    expect((replied.body as { signal: SosSignalDetailView }).signal).toMatchObject({ replyCount: 1 });
    expect((replied.body as { signal: SosSignalDetailView }).signal.replies[0]).toMatchObject({ text: 'Praying now', mine: true });

    done(offlineAction('POST', '/sos/s1/close', { note: 'Thank you all' }, d.world));
    expect((d.reads.get(`${SOS_PATH}?status=open`) as SosListPayload).signals).toEqual([]);
    expect((d.reads.get(`${SOS_PATH}?status=open`) as SosListPayload).openCounts.yellow).toBe(0);
    expect((d.reads.get(`${SOS_PATH}?status=resolved`) as SosListPayload).signals[0]).toMatchObject({ id: 's1', closingNote: 'Thank you all', closedAt: NOW });
    // Closed is closed: the server's refusal, answered here.
    expect(refused(offlineAction('POST', '/sos/s1/close', {}, d.world)).status).toBe(400);
    expect(refused(offlineAction('PUT', '/sos/s1/praying', {}, d.world)).status).toBe(400);
  });

  it('a request never opened on this device is refused; a report is always kept', () => {
    const d = device(boards([]));
    expect(refused(offlineAction('PUT', '/sos/s9/praying', {}, d.world)).status).toBe(503);
    const report = done(offlineAction('POST', '/sos/s9/report', { reason: 'spam' }, d.world));
    expect(report.status).toBe(201);
    expect(report.queue?.label).toBe('A report');
  });
});

describe('the Flow Tracker', () => {
  const teaching = (id: string, tagIds: string[]) => ({ id, title: `T ${id}`, recordedAt: '2026-10-01', series: null, questionCount: 1, tagIds });
  const seed = (question: string, over: object = {}) => ({ kind: 'chapter' as const, question, recording: null, chapter: null, tag: null, ...over });
  const bank: FlowQuestionBankPayload = {
    byTeaching: { r1: [seed('r1 last chapter'), seed('r1 first chapter')], r2: [seed('r2 only')] },
    byTag: {
      t2: [seed('zeal question', { kind: 'tag', tag: { id: 't2', name: 'zeal' } })],
      t1: [seed('grace question', { kind: 'tag', tag: { id: 't1', name: 'grace' } })],
    },
  };
  const reads = () => ({
    [FLOW_TEACHINGS_PATH]: { teachings: [teaching('r2', ['t2']), teaching('r1', ['t1', 't2'])], tagQuestionCounts: {} } satisfies FlowTeachingsPayload,
    [FLOW_QUESTION_BANK_PATH]: bank,
    [FLOW_SESSIONS_PATH]: { active: null, completed: [] } satisfies FlowSessionsPayload,
  });

  it('starts a session with the questions in the server’s order: library order, then tags by name, each once', () => {
    const d = device(reads());
    const outcome = done(offlineAction('POST', FLOW_SESSIONS_PATH, { recordingIds: ['r1', 'r2'] }, d.world));
    const session = (outcome.body as { session: FlowSessionView }).session;
    expect(session.items.map((one) => one.question)).toEqual(['r2 only', 'r1 last chapter', 'r1 first chapter', 'grace question', 'zeal question']);
    expect(session.items.map((one) => one.position)).toEqual([1, 2, 3, 4, 5]);
    expect(session).toMatchObject({ status: 'in_progress', questionCount: 5, answeredCount: 0, teachingCount: 2 });
    expect((d.reads.get(FLOW_SESSIONS_PATH) as FlowSessionsPayload).active?.id).toBe(session.id);
    // The session and every item: each real id is found by position in the server's answer.
    expect(outcome.queue?.creates?.[0]).toEqual({ temp: session.id, at: 'session.id' });
    expect(outcome.queue?.creates?.[3]).toEqual({ temp: session.items[2]?.id, at: 'session.items.2.id' });
  });

  it('refuses a second session, and a start with no questions on the device', () => {
    const d = device({ ...reads(), [FLOW_SESSIONS_PATH]: { active: { id: 'f0' }, completed: [] } });
    expect(refused(offlineAction('POST', FLOW_SESSIONS_PATH, { recordingIds: ['r1'] }, d.world)).code).toBe('flow_session_in_progress');
    expect(refused(offlineAction('POST', FLOW_SESSIONS_PATH, { recordingIds: ['r1'] }, device().world)).status).toBe(503);
  });

  it('answers count up, and the last one completes the session with its gaps as a reading list', () => {
    const d = device(reads());
    const started = (done(offlineAction('POST', FLOW_SESSIONS_PATH, { recordingIds: ['r2'] }, d.world)).body as { session: FlowSessionView }).session;
    const [first, second] = started.items;
    const one = done(offlineAction('PUT', `${flowSessionPath(started.id)}/items/${first?.id}`, { rating: 2 }, d.world));
    expect((one.body as { session: FlowSessionView }).session).toMatchObject({ answeredCount: 1, gapCount: 1, status: 'in_progress', readingList: null });
    const two = done(offlineAction('PUT', `${flowSessionPath(started.id)}/items/${second?.id}`, { rating: 5 }, d.world));
    const finished = (two.body as { session: FlowSessionView }).session;
    expect(finished).toMatchObject({ answeredCount: 2, gapCount: 1, status: 'complete', completedAt: NOW });
    expect(finished.readingList?.[0]?.rows[0]?.item.id).toBe(first?.id);
    const list = d.reads.get(FLOW_SESSIONS_PATH) as FlowSessionsPayload;
    expect(list.active).toBeNull();
    expect(list.completed[0]?.id).toBe(started.id);
    // A finished session takes no more answers, but a row of its reading list can be marked.
    expect(refused(offlineAction('PUT', `${flowSessionPath(started.id)}/items/${first?.id}`, { rating: 4 }, d.world)).status).toBe(400);
    const marked = done(offlineAction('PUT', `${flowSessionPath(started.id)}/items/${first?.id}/done`, { done: true }, d.world));
    expect((marked.body as { session: FlowSessionView }).session.readingList?.[0]?.rows[0]?.item.done).toBe(true);
  });

  it('a session started offline and left offline is cancelled whole; a completed one is removed from the list', () => {
    const d = device(reads());
    const started = (done(offlineAction('POST', FLOW_SESSIONS_PATH, { recordingIds: ['r1'] }, d.world)).body as { session: FlowSessionView }).session;
    d.temps.add(started.id);
    const left = done(offlineAction('POST', `${flowSessionPath(started.id)}/abandon`, null, d.world));
    expect(left.queue).toBeUndefined();
    expect(left.cancel).toBe(started.id);
    expect((d.reads.get(FLOW_SESSIONS_PATH) as FlowSessionsPayload).active).toBeNull();

    const e = device({ [FLOW_SESSIONS_PATH]: { active: null, completed: [{ id: 'f1' }, { id: 'f2' }] } });
    const removed = done(offlineAction('DELETE', flowSessionPath('f1'), null, e.world));
    expect((removed.body as FlowSessionsPayload).completed).toEqual([{ id: 'f2' }]);
  });
});

describe('notifications and the speed', () => {
  const page = (unreadCount: number): NotificationListPayload => ({
    unreadCount,
    nextCursor: null,
    notifications: [
      { id: 'n1', kind: 'announcement', title: 'A', body: 'a', href: null, readAt: null, createdAt: NOW },
      { id: 'n2', kind: 'announcement', title: 'B', body: 'b', href: null, readAt: null, createdAt: NOW },
    ],
  });

  it('marks one read once, and all read at once', () => {
    const d = device({ [NOTIFICATIONS_PATH]: page(2) });
    const one = done(offlineAction('PUT', '/notifications/n1/read', null, d.world));
    expect(one.body).toMatchObject({ unreadCount: 1, notification: { id: 'n1', readAt: NOW } });
    // Reading it again changes no count.
    expect(done(offlineAction('PUT', '/notifications/n1/read', null, d.world)).body).toMatchObject({ unreadCount: 1 });
    const all = done(offlineAction('PUT', '/notifications/read', null, d.world));
    expect(all.body).toEqual({ marked: 1, unreadCount: 0 });
    expect((d.reads.get(NOTIFICATIONS_PATH) as NotificationListPayload).notifications.every((n) => n.readAt !== null)).toBe(true);
  });

  it('sets a notification switch, the last press per category being the one sent', () => {
    const held: PushPreferencesPayload = {
      webPush: null,
      categories: [{ category: 'recordings', label: 'New recordings', description: '', pushEnabled: true }],
    };
    const d = device({ [PUSH_PREFERENCES_PATH]: held });
    const outcome = done(offlineAction('PUT', PUSH_PREFERENCES_PATH, { category: 'recordings', pushEnabled: false }, d.world));
    expect((outcome.body as PushPreferencesPayload).categories[0]?.pushEnabled).toBe(false);
    expect(outcome.queue?.coalesce).toBe('push-preference:recordings');
    expect(refused(offlineAction('PUT', PUSH_PREFERENCES_PATH, { category: 'admin_alerts', pushEnabled: false }, d.world)).status).toBe(400);
  });

  it('keeps a speed change for the account', () => {
    const d = device();
    const outcome = done(offlineAction('PUT', PLAYBACK_SPEED_PATH, { speed: 1.5 }, d.world));
    expect(outcome.body).toEqual({ speed: 1.5 });
    expect(d.speed).toBe(1.5);
    expect(outcome.queue?.coalesce).toBe('playback-speed');
  });
});
