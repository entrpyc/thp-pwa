import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  HIGHLIGHTS_PATH,
  HIGHLIGHT_KINDS,
  MAX_HIGHLIGHTS,
  ROLE,
  highlightPath,
  isApiErrorBody,
  notePath,
  type CreateHighlightRequest,
  type HighlightListPayload,
  type HighlightView,
} from '@thp/shared';
import {
  createDatabase,
  deleteUserAccount,
  findHighlightForMember,
  insertHighlight,
  insertNote,
  insertRecording,
  insertSeries,
  replaceTranscript,
  setRecordingPublication,
  setRecordingSeries,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, signIn, type TestAccount } from '../support/accounts';

/**
 * **Highlights over the API** ([3.15](docs/project/prd.md); [4.14](docs/project/prd.md)) — the
 * playlist a member keeps, driven through the routes a client would use.
 *
 * Six claims:
 *
 * 1. **The list is the caller's own** ([3.15.9](docs/project/prd.md)). `POST` pins and answers
 *    it, `GET` reads it, `DELETE` removes from it; another member's `GET` never shows it, another
 *    member's `DELETE` of an entry removes nothing and says nothing, and no session is `401`.
 * 2. **Three kinds, one entry per target.** A teaching, a moment, a note; pinning again changes
 *    nothing; the three are distinct entries on one teaching.
 * 3. **A moment is snapped to the line playing there** ([3.15.2](docs/project/prd.md)): two
 *    presses in one sentence are one entry, and the entry carries the sentence. A moment with no
 *    line under it is kept as it was pressed.
 * 4. **A note must be readable, standing and top-level** ([3.12.17](docs/project/prd.md)): one's
 *    own, or another member's public one; every other case is one `not_found` sentence. Deleting
 *    the note takes the entry with it.
 * 5. **An unpublished teaching cannot be pinned and leaves the list while unpublished**,
 *    coming back when republished; a deleted account takes its playlist with it (3.1.9).
 * 6. **The ceiling** holds at `MAX_HIGHLIGHTS` with `highlights_full`, and a duplicate press at the
 *    ceiling is still a success.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const MADE_UP_ID = '00000000-0000-4000-8000-000000000000';
const LINE_MS = 2_000;

let handle: DatabaseHandle;

interface Signed extends TestAccount {
  readonly cookie: string;
}

let alice: Signed;
let bob: Signed;

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

async function signedIn(role: 'admin' | 'member', label: string): Promise<Signed> {
  const account = await createAccount(databaseUrl, ROLE[role], `${label}-${RUN}`);
  const result = await signIn(baseUrl, account.email, account.password);
  if (result.cookie === null) throw new Error(`no cookie for ${account.email}`);
  return { ...account, cookie: result.cookie };
}

/** A published teaching; with `lines`, a transcript of that many two-second lines. */
async function recording(title: string, lines = 0): Promise<string> {
  const row = await insertRecording(
    {
      originalMediaKey: `originals/highlights-${title.replace(/\W+/g, '-')}-${RUN}.mp3`,
      title,
      recordedAt: '2026-10-01',
    },
    handle,
  );
  if (lines > 0) {
    await replaceTranscript(
      {
        recordingId: row.id,
        language: 'en',
        confidence: 0.9,
        segments: Array.from({ length: lines }, (_unused, index) => ({
          startMs: index * LINE_MS,
          endMs: (index + 1) * LINE_MS,
          text: `Line ${index + 1} of ${title}.`,
        })),
      },
      handle,
    );
  }
  await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

async function pin(who: Signed, body: CreateHighlightRequest | Record<string, unknown>) {
  return call<HighlightListPayload>(HIGHLIGHTS_PATH, { method: 'POST', cookie: who.cookie, body });
}

async function list(who: Signed): Promise<readonly HighlightView[]> {
  const answer = await call<HighlightListPayload>(HIGHLIGHTS_PATH, { cookie: who.cookie });
  if (answer.status !== 200) throw new Error(`highlights refused ${answer.status}`);
  return answer.body.highlights;
}

async function remove(who: Signed, id: string) {
  return call<HighlightListPayload>(highlightPath(id), { method: 'DELETE', cookie: who.cookie });
}

async function pinned(who: Signed, body: CreateHighlightRequest): Promise<HighlightView> {
  const answer = await pin(who, body);
  if (answer.status !== 200) throw new Error(`pin refused ${answer.status}: ${answer.message}`);
  const found = answer.body.highlights.find((one) =>
    body.kind === 'note'
      ? one.note?.id === body.noteId
      : one.kind === body.kind && one.recording.id === body.recordingId,
  );
  if (found === undefined) throw new Error('the pin is not in the answer');
  return found;
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 6 });
  alice = await signedIn('member', 'hl-alice');
  bob = await signedIn('member', 'hl-bob');
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('the list is the caller’s own', () => {
  it('pins, lists newest first with title, series and date, removes, and refuses no session', async () => {
    const study = await insertSeries({ title: `Study ${RUN}`, description: null }, handle);
    const first = await recording(`First ${RUN}`);
    const second = await recording(`Second ${RUN}`);
    await setRecordingSeries(second, study.id, handle);

    const before = Date.now() - 1_000;
    await pinned(alice, { kind: 'recording', recordingId: first });
    const entry = await pinned(alice, { kind: 'recording', recordingId: second });

    expect(entry.recording.title).toBe(`Second ${RUN}`);
    expect(entry.recording.series?.title).toBe(`Study ${RUN}`);
    expect(entry.positionMs).toBeNull();
    expect(new Date(entry.pinnedAt).getTime()).toBeGreaterThan(before);

    const mine = await list(alice);
    expect(mine.map((one) => one.recording.id)).toEqual([second, first]);

    const gone = await remove(alice, entry.id);
    expect(gone.status).toBe(200);
    expect(gone.body.highlights.map((one) => one.recording.id)).toEqual([first]);
    // Removing it again is an end state the member is already in.
    expect((await remove(alice, entry.id)).status).toBe(200);
    expect((await remove(alice, MADE_UP_ID)).status).toBe(200);
    expect((await remove(alice, 'not-an-id')).code).toBe('invalid_input');

    const anonymous = await call(HIGHLIGHTS_PATH, {});
    expect(anonymous.status).toBe(401);
  });

  it('shows nobody else’s list and lets nobody else remove from it', async () => {
    const where = await recording(`Private ${RUN}`);
    const entry = await pinned(alice, { kind: 'recording', recordingId: where });

    const bobs = await list(bob);
    expect(bobs.some((one) => one.id === entry.id)).toBe(false);

    // Bob's delete of Alice's entry: success, nothing removed, nothing revealed.
    const attempt = await remove(bob, entry.id);
    expect(attempt.status).toBe(200);
    expect(attempt.body.highlights.some((one) => one.id === entry.id)).toBe(false);
    expect(await findHighlightForMember(entry.id, alice.id, handle)).not.toBeNull();
    expect((await list(alice)).some((one) => one.id === entry.id)).toBe(true);
  });

  it('refuses a malformed body before it reaches a statement', async () => {
    const where = await recording(`Malformed ${RUN}`);
    expect((await pin(alice, { kind: 'bookmark', recordingId: where })).code).toBe('invalid_input');
    expect((await pin(alice, { kind: 'recording', recordingId: 'nope' })).code).toBe('invalid_input');
    expect((await pin(alice, { kind: 'segment', recordingId: where, positionMs: -1 })).code).toBe(
      'invalid_input',
    );
    expect((await pin(alice, { kind: 'segment', recordingId: where, positionMs: 1.5 })).code).toBe(
      'invalid_input',
    );
    expect((await pin(alice, { kind: 'note', noteId: 42 })).code).toBe('invalid_input');
    expect((await pin(alice, { kind: 'recording', recordingId: MADE_UP_ID })).code).toBe('not_found');
  });
});

describe('three kinds, one entry per target', () => {
  it('keeps a teaching, a moment and a note of it as three entries, each pinned once', async () => {
    const where = await recording(`Kinds ${RUN}`, 5);
    const note = await insertNote(
      { recordingId: where, authorId: alice.id, visibility: 'private', text: 'Mine.', timestampMs: 4_500 },
      handle,
    );

    await pinned(alice, { kind: 'recording', recordingId: where });
    await pinned(alice, { kind: 'segment', recordingId: where, positionMs: 2_500 });
    const ofNote = await pinned(alice, { kind: 'note', noteId: note.id });

    // The note's moment is the note's, and its text rides along.
    expect(ofNote.positionMs).toBe(4_500);
    expect(ofNote.note).toEqual({ id: note.id, text: 'Mine.' });

    // Again, all three: nothing changes.
    await pinned(alice, { kind: 'recording', recordingId: where });
    await pinned(alice, { kind: 'segment', recordingId: where, positionMs: 2_500 });
    await pinned(alice, { kind: 'note', noteId: note.id });

    const here = (await list(alice)).filter((one) => one.recording.id === where);
    expect(here.map((one) => one.kind).sort()).toEqual([...HIGHLIGHT_KINDS].sort());
  });
});

describe('a moment is snapped to the line playing there', () => {
  it('stores the line’s start and text, folds presses in one line, and keeps an unlined moment raw', async () => {
    const where = await recording(`Snap ${RUN}`, 3);

    const first = await pinned(alice, { kind: 'segment', recordingId: where, positionMs: 3_100 });
    expect(first.positionMs).toBe(2_000);
    expect(first.segment).toEqual({ startMs: 2_000, endMs: 4_000, text: `Line 2 of Snap ${RUN}.` });

    const again = await pinned(alice, { kind: 'segment', recordingId: where, positionMs: 3_900 });
    expect(again.id).toBe(first.id);

    // After the last line: nothing to snap to, so the moment stands as pressed.
    const late = await pinned(alice, { kind: 'segment', recordingId: where, positionMs: 9_000 });
    expect(late.positionMs).toBe(9_000);
    expect(late.segment).toBeNull();

    const here = (await list(alice)).filter((one) => one.recording.id === where);
    expect(here).toHaveLength(2);
  });
});

describe('a note must be readable, standing and top-level', () => {
  it('refuses everything else with one sentence, and the entry goes with the note', async () => {
    const where = await recording(`Notes ${RUN}`, 2);
    const mine = await insertNote(
      { recordingId: where, authorId: alice.id, visibility: 'public', text: 'Alice.', timestampMs: 1_000 },
      handle,
    );
    const theirs = await insertNote(
      { recordingId: where, authorId: bob.id, visibility: 'public', text: 'Bob.', timestampMs: 1_500 },
      handle,
    );
    const theirPrivate = await insertNote(
      { recordingId: where, authorId: bob.id, visibility: 'private', text: 'Bob alone.', timestampMs: 500 },
      handle,
    );
    const reply = await insertNote(
      { recordingId: where, authorId: alice.id, visibility: 'public', text: 'A reply.', parentId: theirs.id },
      handle,
    );

    // Somebody else's public note is readable, so it is pinnable.
    const theirsPinned = await pinned(alice, { kind: 'note', noteId: theirs.id });
    expect(theirsPinned.note?.text).toBe('Bob.');

    const refusedPrivate = await pin(alice, { kind: 'note', noteId: theirPrivate.id });
    const refusedReply = await pin(alice, { kind: 'note', noteId: reply.id });
    const refusedNobody = await pin(alice, { kind: 'note', noteId: MADE_UP_ID });
    for (const refused of [refusedPrivate, refusedReply, refusedNobody]) {
      expect(refused.status).toBe(404);
      expect(refused.code).toBe('not_found');
      expect(refused.message).toBe(refusedNobody.message);
    }

    const entry = await pinned(alice, { kind: 'note', noteId: mine.id });
    expect(entry.recording.id).toBe(where);

    // Deleting the note through its own route takes the entry with it, in the same breath.
    const deleted = await call(notePath(mine.id), { method: 'DELETE', cookie: alice.cookie });
    expect(deleted.status).toBe(200);
    expect(await findHighlightForMember(entry.id, alice.id, handle)).toBeNull();
    expect((await list(alice)).some((one) => one.id === entry.id)).toBe(false);
    // And it is not pinnable again.
    expect((await pin(alice, { kind: 'note', noteId: mine.id })).code).toBe('not_found');
  });
});

describe('what the list leaves out, and what goes with an account', () => {
  it('cannot pin an unpublished teaching, hides a pinned one while unpublished, and shows it again', async () => {
    const draft = await insertRecording(
      { originalMediaKey: `originals/highlights-draft-${RUN}.mp3`, title: `Draft ${RUN}`, recordedAt: '2026-10-01' },
      handle,
    );
    const refused = await pin(alice, { kind: 'recording', recordingId: draft.id });
    expect(refused.code).toBe('not_found');

    const where = await recording(`Unpublish ${RUN}`);
    const entry = await pinned(alice, { kind: 'recording', recordingId: where });

    await setRecordingPublication(where, null, handle);
    expect((await list(alice)).some((one) => one.id === entry.id)).toBe(false);
    // Kept, not deleted: the member's choice outlives the admin's.
    expect(await findHighlightForMember(entry.id, alice.id, handle)).not.toBeNull();

    await setRecordingPublication(where, new Date(), handle);
    expect((await list(alice)).some((one) => one.id === entry.id)).toBe(true);
  });

  it('goes with the account (3.1.9)', async () => {
    const leaver = await signedIn('member', 'hl-leaver');
    const where = await recording(`Leaving ${RUN}`);
    const entry = await pinned(leaver, { kind: 'recording', recordingId: where });

    const result = await deleteUserAccount(leaver.id, handle);
    expect(result.outcome).toBe('applied');
    expect(await findHighlightForMember(entry.id, leaver.id, handle)).toBeNull();
  });
});

describe('the ceiling', () => {
  it(`refuses the ${MAX_HIGHLIGHTS + 1}th entry with highlights_full, and still accepts a duplicate`, async () => {
    const full = await signedIn('member', 'hl-full');
    const where = await recording(`Full ${RUN}`);
    // Written straight to the table: the ceiling is about the count, not about how it was reached.
    // Distinct moments on one teaching, unsnapped — no transcript — so each is its own entry.
    for (let index = 0; index < MAX_HIGHLIGHTS; index += 1) {
      await insertHighlight(
        { userId: full.id, recordingId: where, kind: 'segment', positionMs: index * 1_000 },
        handle,
      );
    }

    const refused = await pin(full, { kind: 'recording', recordingId: where });
    expect(refused.status).toBe(409);
    expect(refused.code).toBe('highlights_full');

    const duplicate = await pin(full, { kind: 'segment', recordingId: where, positionMs: 0 });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.highlights).toHaveLength(MAX_HIGHLIGHTS);

    // One removal, and there is room again.
    const first = duplicate.body.highlights[0];
    if (first === undefined) throw new Error('no entry to remove');
    expect((await remove(full, first.id)).status).toBe(200);
    expect((await pin(full, { kind: 'recording', recordingId: where })).status).toBe(200);
  }, 120_000);
});
