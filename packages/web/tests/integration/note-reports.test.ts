import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  NOTIFICATIONS_PATH,
  REPORTS_PATH,
  REPORT_DISMISSED_TITLE,
  REPORT_REASONS,
  REPORT_REMOVED_TITLE,
  ROLE,
  TERMS_ACCEPTANCE_PATH,
  TERMS_REQUIRED_MESSAGE,
  TERMS_VERSION,
  isApiErrorBody,
  noteReportPath,
  notePath,
  recordingNotesPath,
  reportResolvePath,
  type CreateNotePayload,
  type NoteReportView,
  type NoteView,
  type NotesPayload,
  type NotificationListPayload,
  type ReportListPayload,
  type ReportNotePayload,
  type ResolveReportPayload,
  type TermsAcceptancePayload,
} from '@thp/shared';
import {
  createDatabase,
  findNoteReportById,
  findUserById,
  insertRecording,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { BLOCKED_WORDS } from '@/server/notes/blocked-words';
import { closeTestDatabase, createAccount, signIn, type TestAccount } from '../support/accounts';
import { readWholeInbox } from '../support/inbox';

/**
 * **The member-facing moderation controls over the API** (Apple guideline 1.2, Google Play's UGC
 * policy): reporting a note, the admin's queue and its two resolutions, the word filter at write
 * time, and the terms gate with the acceptance that opens it.
 *
 * Six claims:
 *
 * 1. **A report is a row and a notice.** `POST /notes/{id}/report` answers `201` with an id, every
 *    active admin is told and the reporter is not; the same member reporting the same note again
 *    answers the first id with `200`, and nothing new is written.
 * 2. **The refusals are the service's.** Your own note and a private note are `invalid_input`, a
 *    removed note is `note_removed`, a reason off the list is `invalid_input`, and a member cannot
 *    read the queue or resolve anything.
 * 3. **The queue is the open reports, oldest first, with the note as it reads now.**
 * 4. **Resolving is by note.** Dismissing closes every open report on the note and tells each
 *    reporter the note stays; removing deletes the note through the moderation path, closes the
 *    reports and tells each reporter it went. A second resolution closes nothing and says so.
 * 5. **The filter refuses public text, not private text, and never truncates.**
 * 6. **The terms gate.** An account with no acceptance is refused `terms_required` on a note and
 *    on a reply, accepts through `PUT /users/me/terms` with the current version only, and is then
 *    let through; the row records the version and the moment.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const MADE_UP_ID = '00000000-0000-4000-8000-000000000000';
const BLOCKED = BLOCKED_WORDS[0] ?? '';

let handle: DatabaseHandle;

interface Signed extends TestAccount {
  readonly cookie: string;
}

let alice: Signed;
let bob: Signed;
let carol: Signed;
let admin: Signed;
let secondAdmin: Signed;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly message: string;
  readonly body: T;
}

async function call<T>(
  path: string,
  init: { method?: string; cookie?: string; body?: unknown },
): Promise<Answer<T>> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body = (await response.json().catch(() => undefined)) as unknown;
  return {
    status: response.status,
    code: isApiErrorBody(body) ? body.error.code : null,
    message: isApiErrorBody(body) ? body.error.message : '',
    body: body as T,
  };
}

async function signedIn(
  role: 'admin' | 'member',
  label: string,
  options: { readonly termsAccepted?: boolean } = {},
): Promise<Signed> {
  const account = await createAccount(databaseUrl, ROLE[role], `${label}-${RUN}`, undefined, options);
  const result = await signIn(baseUrl, account.email, account.password);
  if (result.cookie === null) throw new Error(`no cookie for ${account.email}`);
  return { ...account, cookie: result.cookie };
}

async function recording(title: string): Promise<string> {
  const row = await insertRecording(
    {
      originalMediaKey: `originals/reports-${title.replace(/\W+/g, '-')}-${RUN}.mp3`,
      title,
      recordedAt: '2026-10-01',
    },
    handle,
  );
  await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

async function write(recordingId: string, who: Signed, body: Record<string, unknown>): Promise<NoteView> {
  const answer = await call<CreateNotePayload>(recordingNotesPath(recordingId), {
    method: 'POST',
    cookie: who.cookie,
    body,
  });
  if (answer.status !== 200) throw new Error(`note refused ${answer.status}: ${answer.message}`);
  return answer.body.note;
}

async function report(noteId: string, who: Signed, body: unknown = { reason: REPORT_REASONS[0] }) {
  return call<ReportNotePayload>(noteReportPath(noteId), { method: 'POST', cookie: who.cookie, body });
}

async function queue(who: Signed) {
  return call<ReportListPayload>(REPORTS_PATH, { cookie: who.cookie });
}

async function resolve(reportId: string, who: Signed, outcome: string) {
  return call<ResolveReportPayload>(reportResolvePath(reportId), {
    method: 'POST',
    cookie: who.cookie,
    body: { outcome },
  });
}

/** This run's notices of one kind in somebody's centre. */
async function notices(who: Signed, kind: string): Promise<NotificationListPayload['notifications']> {
  return (await readWholeInbox(baseUrl, who.cookie)).notifications.filter((one) => one.kind === kind);
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
  [alice, bob, carol, admin, secondAdmin] = await Promise.all([
    signedIn('member', 'report-alice'),
    signedIn('member', 'report-bob'),
    signedIn('member', 'report-carol'),
    signedIn('admin', 'report-admin'),
    signedIn('admin', 'report-admin-two'),
  ]);
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('reporting a note', () => {
  let where: string;
  let bobsNote: string;
  let bobsReply: string;
  let alicesPrivate: string;

  beforeAll(async () => {
    where = await recording(`Reports ${RUN}`);
    bobsNote = (await write(where, bob, { text: `Bob ${RUN}`, visibility: 'public', timestampMs: 1_000 })).id;
    bobsReply = (await write(where, bob, { text: `Bob replies ${RUN}`, parentId: bobsNote })).id;
    alicesPrivate = (await write(where, alice, { text: `Alice private ${RUN}`, visibility: 'private', timestampMs: 2_000 })).id;
  }, 60_000);

  it('refuses an anonymous caller, and refuses a member the queue and the resolution', async () => {
    expect((await call(noteReportPath(bobsNote), { method: 'POST' })).status).toBe(401);
    expect((await call(REPORTS_PATH, {})).status).toBe(401);

    const list = await queue(alice);
    expect(list.status).toBe(403);
    expect(list.code).toBe('forbidden');
    const closing = await resolve(MADE_UP_ID, alice, 'dismissed');
    expect(closing.status).toBe(403);
    expect(closing.code).toBe('forbidden');
  });

  it('refuses your own note, a private note, a reason off the list and a removed note', async () => {
    const own = await report(bobsNote, bob);
    expect(own.status).toBe(400);
    expect(own.code).toBe('invalid_input');
    expect(own.message).toContain('your own note');

    const privateOne = await report(alicesPrivate, bob);
    expect(privateOne.code).toBe('invalid_input');
    // Its own author cannot either: nobody else can see it, so there is nothing to report.
    expect((await report(alicesPrivate, alice)).code).toBe('invalid_input');

    expect((await report(bobsNote, alice, { reason: 'rude' })).code).toBe('invalid_input');
    expect((await report(bobsNote, alice, { reason: REPORT_REASONS[0], detail: 'x'.repeat(501) })).code).toBe(
      'invalid_input',
    );
    expect((await report(bobsNote, alice, null)).code).toBe('invalid_input');

    const gone = (await write(where, carol, { text: `Carol gone ${RUN}`, visibility: 'public', timestampMs: 3_000 })).id;
    expect((await call(notePath(gone), { method: 'DELETE', cookie: carol.cookie })).status).toBe(200);
    const removed = await report(gone, alice);
    expect(removed.status).toBe(409);
    expect(removed.code).toBe('note_removed');

    expect((await report(MADE_UP_ID, alice)).code).toBe('not_found');
  });

  it('takes a report on a note and on a reply, tells every other admin once, and repeats nothing', async () => {
    const adminBefore = (await notices(admin, 'note_reported')).length;
    const secondBefore = (await notices(secondAdmin, 'note_reported')).length;

    const first = await report(bobsNote, alice, { reason: 'harassment', detail: '  Please look.  ' });
    expect(first.status).toBe(201);
    expect(first.body.reportId).toMatch(/^[0-9a-f-]{36}$/);

    const row = await findNoteReportById(first.body.reportId, handle);
    expect(row?.noteId).toBe(bobsNote);
    expect(row?.reporterId).toBe(alice.id);
    expect(row?.reason).toBe('harassment');
    expect(row?.detail).toBe('Please look.');
    expect(row?.resolvedAt).toBeNull();

    // A second press by the same member is the first report, and writes nothing.
    const again = await report(bobsNote, alice, { reason: 'spam' });
    expect(again.status).toBe(200);
    expect(again.body.reportId).toBe(first.body.reportId);
    expect((await findNoteReportById(first.body.reportId, handle))?.reason).toBe('harassment');

    // A reply is reported on the same terms.
    const onReply = await report(bobsReply, carol, { reason: 'other' });
    expect(onReply.status).toBe(201);

    // Every admin was told once per report, by the reporter's name, with a press into the console.
    const adminNow = await notices(admin, 'note_reported');
    expect(adminNow.length).toBe(adminBefore + 2);
    expect(adminNow.some((one) => one.title === `${alice.displayName} reported a note`)).toBe(true);
    expect(adminNow.some((one) => one.title === `${carol.displayName} reported a note`)).toBe(true);
    expect(adminNow[0]?.href).toBe('/admin/reports');
    expect(adminNow[0]?.body).toMatch(/^Something else: |^Harassment or threats: /);
    expect((await notices(secondAdmin, 'note_reported')).length).toBe(secondBefore + 2);
    // The reporter hears nothing of their own report, and the author is not told who reported them.
    expect((await notices(alice, 'note_reported')).length).toBe(0);
    expect((await notices(bob, 'note_reported')).length).toBe(0);
  });

  it('lists open reports to an admin, oldest first, with the note, its author, the reporter and the teaching', async () => {
    const list = await queue(admin);
    expect(list.status).toBe(200);
    const ours = list.body.reports.filter(
      (one): one is NoteReportView => one.kind === 'note' && one.recordingId === where,
    );
    expect(ours.map((one) => one.noteId)).toEqual([bobsNote, bobsReply]);

    const [onNote, onReply] = ours;
    expect(onNote?.reason).toBe('harassment');
    expect(onNote?.detail).toBe('Please look.');
    expect(onNote?.noteText).toBe(`Bob ${RUN}`);
    expect(onNote?.noteDeleted).toBe(false);
    expect(onNote?.noteAuthorDisplayName).toBe(bob.displayName);
    expect(onNote?.reporterDisplayName).toBe(alice.displayName);
    expect(onNote?.recordingTitle).toBe(`Reports ${RUN}`);
    expect(onReply?.reporterDisplayName).toBe(carol.displayName);
    // Nobody's address travels.
    expect(JSON.stringify(list.body)).not.toContain('@example.test');
  });

  it('dismisses by note: every open report on it closes, and each reporter is told the note stays', async () => {
    // A second report on the same note by a third member, so "by note" has something to close.
    const third = await report(bobsNote, carol, { reason: 'spam' });
    expect(third.status).toBe(201);
    const aliceBefore = (await notices(alice, 'report_resolved')).length;
    const carolBefore = (await notices(carol, 'report_resolved')).length;

    const open = (await queue(admin)).body.reports.filter(
      (one) => one.kind === 'note' && one.noteId === bobsNote,
    );
    expect(open).toHaveLength(2);

    const closed = await resolve(open[0]?.id ?? '', admin, 'dismissed');
    expect(closed.status).toBe(200);
    expect(closed.body.outcome).toBe('dismissed');
    expect(closed.body.closed).toBe(2);
    expect(closed.body.reports.some((one) => one.kind === 'note' && one.noteId === bobsNote)).toBe(false);

    // The note is still there and still reads.
    const notes = await call<NotesPayload>(recordingNotesPath(where), { cookie: alice.cookie });
    expect(notes.body.notes.find((one) => one.id === bobsNote)?.text).toBe(`Bob ${RUN}`);

    // Each reporter heard once, with the sentence for a note that stays.
    const aliceNow = await notices(alice, 'report_resolved');
    expect(aliceNow.length).toBe(aliceBefore + 1);
    expect(aliceNow[0]?.title).toBe(REPORT_DISMISSED_TITLE);
    expect(aliceNow[0]?.href).toBe(`/recordings/${where}`);
    expect((await notices(carol, 'report_resolved')).length).toBe(carolBefore + 1);

    // Resolving it again closes nothing and says what was decided.
    const again = await resolve(open[0]?.id ?? '', secondAdmin, 'removed');
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe('dismissed');
    expect(again.body.closed).toBe(0);
    expect((await findNoteReportById(open[0]?.id ?? '', handle))?.resolvedBy).toBe(admin.id);
  });

  it('removes through the moderation path: the note becomes a tombstone, and the reporter is told', async () => {
    const carolBefore = (await notices(carol, 'report_resolved')).length;
    const open = (await queue(admin)).body.reports.filter(
      (one) => one.kind === 'note' && one.noteId === bobsReply,
    );
    expect(open).toHaveLength(1);

    const removed = await resolve(open[0]?.id ?? '', admin, 'removed');
    expect(removed.status).toBe(200);
    expect(removed.body.outcome).toBe('removed');
    expect(removed.body.closed).toBe(1);

    // The reply is gone from the thread exactly as an admin's Delete would have left it.
    const notes = await call<NotesPayload>(recordingNotesPath(where), { cookie: alice.cookie });
    const parent = notes.body.notes.find((one) => one.id === bobsNote);
    expect(parent?.replies.map((one) => one.id)).not.toContain(bobsReply);

    const carolNow = await notices(carol, 'report_resolved');
    expect(carolNow.length).toBe(carolBefore + 1);
    expect(carolNow[0]?.title).toBe(REPORT_REMOVED_TITLE);

    expect((await resolve(MADE_UP_ID, admin, 'dismissed')).code).toBe('not_found');
    expect((await resolve(open[0]?.id ?? '', admin, 'ignored')).code).toBe('invalid_input');
  });

  it('removes a note its author already removed without complaint, and lists it as removed first', async () => {
    const doomed = (await write(where, bob, { text: `Bob doomed ${RUN}`, visibility: 'public', timestampMs: 9_000 })).id;
    const made = await report(doomed, alice);
    expect(made.status).toBe(201);
    expect((await call(notePath(doomed), { method: 'DELETE', cookie: bob.cookie })).status).toBe(200);

    const listed = (await queue(admin)).body.reports.find((one) => one.id === made.body.reportId);
    if (listed?.kind !== 'note') throw new Error('the report on a note was not listed as one');
    expect(listed.noteDeleted).toBe(true);
    expect(listed.noteText).toBe('');

    const removed = await resolve(made.body.reportId, admin, 'removed');
    expect(removed.status).toBe(200);
    expect(removed.body.closed).toBe(1);
  });
});

// =================================================================================================

describe('the word filter at write time', () => {
  let where: string;

  beforeAll(async () => {
    where = await recording(`Filter ${RUN}`);
  }, 60_000);

  it('refuses a public note and a reply carrying a listed word, with a sentence that quotes nothing', async () => {
    const refused = await call(recordingNotesPath(where), {
      method: 'POST',
      cookie: alice.cookie,
      body: { text: `Well, ${BLOCKED}.`, visibility: 'public', timestampMs: 1_000 },
    });
    expect(refused.status).toBe(400);
    expect(refused.code).toBe('invalid_input');
    expect(refused.message).toContain('language the group does not allow');
    expect(refused.message.toLowerCase()).not.toContain(BLOCKED);

    const parent = await write(where, bob, { text: `Parent ${RUN}`, visibility: 'public', timestampMs: 2_000 });
    const reply = await call(recordingNotesPath(where), {
      method: 'POST',
      cookie: alice.cookie,
      body: { text: `${BLOCKED.toUpperCase()}!`, parentId: parent.id },
    });
    expect(reply.code).toBe('invalid_input');

    // Nothing landed.
    const notes = await call<NotesPayload>(recordingNotesPath(where), { cookie: alice.cookie });
    expect(JSON.stringify(notes.body).toLowerCase()).not.toContain(BLOCKED);
  });

  it('refuses an edit that would put the word in afterwards', async () => {
    const mine = await write(where, alice, { text: `Clean ${RUN}`, visibility: 'public', timestampMs: 3_000 });
    const edited = await call(notePath(mine.id), {
      method: 'PATCH',
      cookie: alice.cookie,
      body: { text: `Now ${BLOCKED}` },
    });
    expect(edited.code).toBe('invalid_input');
    const notes = await call<NotesPayload>(recordingNotesPath(where), { cookie: alice.cookie });
    expect(notes.body.notes.find((one) => one.id === mine.id)?.text).toBe(`Clean ${RUN}`);
  });

  it('lets a private note through untouched, and never matches a word inside a word', async () => {
    const privateOne = await write(where, alice, {
      text: `My own ${BLOCKED} ${RUN}`,
      visibility: 'private',
      timestampMs: 4_000,
    });
    expect(privateOne.text).toBe(`My own ${BLOCKED} ${RUN}`);

    const inside = await write(where, alice, {
      text: `un${BLOCKED}able ${RUN}`,
      visibility: 'public',
      timestampMs: 5_000,
    });
    expect(inside.text).toBe(`un${BLOCKED}able ${RUN}`);
  });
});

// =================================================================================================

describe('the terms gate and the acceptance that opens it', () => {
  let where: string;
  let newcomer: Signed;
  let parent: string;

  beforeAll(async () => {
    where = await recording(`Terms ${RUN}`);
    // As an invitation or an older account would have left it: nothing accepted.
    newcomer = await signedIn('member', 'report-newcomer', { termsAccepted: false });
    parent = (await write(where, bob, { text: `Reply here ${RUN}`, visibility: 'public', timestampMs: 1_000 })).id;
  }, 60_000);

  it('refuses a note and a reply from an account with no acceptance, with the prompt’s sentence', async () => {
    const note = await call(recordingNotesPath(where), {
      method: 'POST',
      cookie: newcomer.cookie,
      body: { text: `Too soon ${RUN}`, visibility: 'private', timestampMs: 2_000 },
    });
    expect(note.status).toBe(403);
    expect(note.code).toBe('terms_required');
    expect(note.message).toBe(TERMS_REQUIRED_MESSAGE);

    const reply = await call(recordingNotesPath(where), {
      method: 'POST',
      cookie: newcomer.cookie,
      body: { text: `Too soon reply ${RUN}`, parentId: parent },
    });
    expect(reply.code).toBe('terms_required');

    // Reading is not gated: the terms are about posting.
    expect((await call(recordingNotesPath(where), { cookie: newcomer.cookie })).status).toBe(200);
  });

  it('accepts only the current version, records it on the row, and then lets the note through', async () => {
    expect((await call(TERMS_ACCEPTANCE_PATH, { method: 'PUT', body: { termsVersion: TERMS_VERSION } })).status).toBe(401);

    const stale = await call(TERMS_ACCEPTANCE_PATH, {
      method: 'PUT',
      cookie: newcomer.cookie,
      body: { termsVersion: '2000-01-01' },
    });
    expect(stale.status).toBe(400);
    expect(stale.code).toBe('invalid_input');
    expect(stale.message).toContain(TERMS_VERSION);
    expect((await call(TERMS_ACCEPTANCE_PATH, { method: 'PUT', cookie: newcomer.cookie, body: null })).code).toBe(
      'invalid_input',
    );
    expect((await findUserById(newcomer.id, handle))?.termsAcceptedVersion).toBeNull();

    const accepted = await call<TermsAcceptancePayload>(TERMS_ACCEPTANCE_PATH, {
      method: 'PUT',
      cookie: newcomer.cookie,
      body: { termsVersion: TERMS_VERSION },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.termsVersion).toBe(TERMS_VERSION);
    expect(new Date(accepted.body.acceptedAt).getTime()).not.toBeNaN();

    const row = await findUserById(newcomer.id, handle);
    expect(row?.termsAcceptedVersion).toBe(TERMS_VERSION);
    expect(row?.termsAcceptedAt?.toISOString()).toBe(accepted.body.acceptedAt);

    // The same session, the same request: let through now.
    const note = await write(where, newcomer, { text: `In time ${RUN}`, visibility: 'public', timestampMs: 3_000 });
    expect(note.text).toBe(`In time ${RUN}`);
  });
});
