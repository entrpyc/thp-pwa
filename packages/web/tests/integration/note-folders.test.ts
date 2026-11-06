import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  MAX_NOTE_FOLDERS,
  MAX_NOTE_FOLDER_NAME_LENGTH,
  NOTE_FOLDERS_PATH,
  ROLE,
  isApiErrorBody,
  noteFolderPath,
  noteFoldersPath,
  notePath,
  type NoteFolderView,
  type NoteFoldersPayload,
} from '@thp/shared';
import {
  createDatabase,
  insertNote,
  insertNoteFolder,
  insertRecording,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, signIn, type TestAccount } from '../support/accounts';

/**
 * **Note folders over the API** — the folders a member sorts their own notes into, driven through
 * the routes the picker and the *My notes* page use.
 *
 * Five claims:
 *
 * 1. **The list is the caller's own.** `POST` creates and answers it, `GET` reads it by name,
 *    `PATCH` renames, `DELETE` removes; another member's `GET` never shows it, another member's
 *    `PATCH` is `not_found` and their `DELETE` removes nothing and says nothing; no session is `401`.
 * 2. **A name is one per member**, trimmed and compared without case: a second `sermons` is
 *    `note_folder_exists`, on create and on rename alike; a blank or over-long name is
 *    `invalid_input`.
 * 3. **Filing is the author's, on a top-level note, into their own folders.** `PUT` replaces the
 *    set, and an empty set unfiles; a note in several folders is listed under each. Another
 *    member's note, a reply, a tombstone and a folder that is not the caller's are each one
 *    `not_found` sentence.
 * 4. **Deleting a folder leaves its notes**; deleting a note takes it out of every folder.
 * 5. **The ceiling** holds at `MAX_NOTE_FOLDERS` with `note_folders_full`.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const MADE_UP_ID = '00000000-0000-4000-8000-000000000000';

let handle: DatabaseHandle;

interface Signed extends TestAccount {
  readonly cookie: string;
}

let alice: Signed;
let bob: Signed;
let teaching: string;

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

async function signedIn(label: string): Promise<Signed> {
  const account = await createAccount(databaseUrl, ROLE.member, `${label}-${RUN}`);
  const result = await signIn(baseUrl, account.email, account.password);
  if (result.cookie === null) throw new Error(`no cookie for ${account.email}`);
  return { ...account, cookie: result.cookie };
}

async function folders(who: Signed): Promise<readonly NoteFolderView[]> {
  const answer = await call<NoteFoldersPayload>(NOTE_FOLDERS_PATH, { cookie: who.cookie });
  if (answer.status !== 200) throw new Error(`folders refused ${answer.status}`);
  return answer.body.folders;
}

async function create(who: Signed, name: string): Promise<Answer<NoteFoldersPayload>> {
  return call<NoteFoldersPayload>(NOTE_FOLDERS_PATH, { method: 'POST', cookie: who.cookie, body: { name } });
}

/** Create and answer the new folder, found by name in the list the API returned. */
async function folder(who: Signed, name: string): Promise<NoteFolderView> {
  const answer = await create(who, name);
  if (answer.status !== 200) throw new Error(`create refused ${answer.status}: ${answer.message}`);
  const made = answer.body.folders.find((one) => one.name === name);
  if (made === undefined) throw new Error(`no folder named ${name} in the answer`);
  return made;
}

async function file(who: Signed, noteId: string, folderIds: readonly string[]): Promise<Answer<NoteFoldersPayload>> {
  return call<NoteFoldersPayload>(noteFoldersPath(noteId), { method: 'PUT', cookie: who.cookie, body: { folderIds } });
}

async function ownNote(who: Signed, text: string): Promise<string> {
  const row = await insertNote(
    { recordingId: teaching, authorId: who.id, visibility: 'public', text, timestampMs: 1_000 },
    handle,
  );
  return row.id;
}

function idsIn(list: readonly NoteFolderView[], folderId: string): readonly string[] {
  return list.find((one) => one.id === folderId)?.noteIds ?? [];
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 6 });
  alice = await signedIn('nf-alice');
  bob = await signedIn('nf-bob');
  const row = await insertRecording(
    { originalMediaKey: `originals/note-folders-${RUN}.mp3`, title: `Folders ${RUN}`, recordedAt: '2026-10-01' },
    handle,
  );
  await setRecordingPublication(row.id, new Date(), handle);
  teaching = row.id;
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('the list is the caller’s own', () => {
  it('creates, lists by name, renames and removes — and nobody else sees any of it', async () => {
    const zebra = await folder(alice, `Zebra ${RUN}`);
    const apple = await folder(alice, `apple ${RUN}`);

    const listed = await folders(alice);
    const names = listed.filter((one) => one.id === zebra.id || one.id === apple.id).map((one) => one.name);
    expect(names).toEqual([`apple ${RUN}`, `Zebra ${RUN}`]);
    expect(listed.every((one) => one.noteIds.length === 0 || one.id !== apple.id)).toBe(true);

    // Bob's list has none of Alice's.
    const bobs = await folders(bob);
    expect(bobs.some((one) => one.id === zebra.id || one.id === apple.id)).toBe(false);

    // Bob cannot rename hers: not_found, the same as an id that is nobody's.
    const theft = await call(noteFolderPath(zebra.id), { method: 'PATCH', cookie: bob.cookie, body: { name: 'Mine now' } });
    expect(theft.status).toBe(404);
    expect(theft.code).toBe('not_found');
    const nobody = await call(noteFolderPath(MADE_UP_ID), { method: 'PATCH', cookie: alice.cookie, body: { name: 'x' } });
    expect(nobody.status).toBe(404);
    expect(nobody.message).toBe(theft.message);

    // Bob's delete of hers removes nothing and says nothing.
    const bobDelete = await call<NoteFoldersPayload>(noteFolderPath(zebra.id), { method: 'DELETE', cookie: bob.cookie });
    expect(bobDelete.status).toBe(200);
    expect((await folders(alice)).some((one) => one.id === zebra.id)).toBe(true);

    // Alice renames and removes her own.
    const renamed = await call<NoteFoldersPayload>(noteFolderPath(zebra.id), {
      method: 'PATCH',
      cookie: alice.cookie,
      body: { name: `  Yak   ${RUN} ` },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.folders.find((one) => one.id === zebra.id)?.name).toBe(`Yak ${RUN}`);

    const removed = await call<NoteFoldersPayload>(noteFolderPath(zebra.id), { method: 'DELETE', cookie: alice.cookie });
    expect(removed.status).toBe(200);
    expect(removed.body.folders.some((one) => one.id === zebra.id)).toBe(false);
  });

  it('refuses every route without a session', async () => {
    const anonymous = [
      call(NOTE_FOLDERS_PATH, {}),
      call(NOTE_FOLDERS_PATH, { method: 'POST', body: { name: 'x' } }),
      call(noteFolderPath(MADE_UP_ID), { method: 'PATCH', body: { name: 'x' } }),
      call(noteFolderPath(MADE_UP_ID), { method: 'DELETE' }),
      call(noteFoldersPath(MADE_UP_ID), { method: 'PUT', body: { folderIds: [] } }),
    ];
    for (const answer of await Promise.all(anonymous)) expect(answer.status).toBe(401);
  });
});

describe('a name is one per member', () => {
  it('refuses a second folder with the same name in any case or spacing, on create and on rename', async () => {
    const first = await folder(alice, `Sermons ${RUN}`);
    const again = await create(alice, `  sermons   ${RUN} `);
    expect(again.status).toBe(409);
    expect(again.code).toBe('note_folder_exists');

    // Bob may have one of the same name: the rule is per member.
    expect((await create(bob, `Sermons ${RUN}`)).status).toBe(200);

    const other = await folder(alice, `Other ${RUN}`);
    const collide = await call(noteFolderPath(other.id), { method: 'PATCH', cookie: alice.cookie, body: { name: `SERMONS ${RUN}` } });
    expect(collide.status).toBe(409);
    expect(collide.code).toBe('note_folder_exists');

    // Renaming to one's own current name is fine.
    const same = await call(noteFolderPath(first.id), { method: 'PATCH', cookie: alice.cookie, body: { name: `Sermons ${RUN}` } });
    expect(same.status).toBe(200);
  });

  it('refuses a blank, a missing or an over-long name', async () => {
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(MAX_NOTE_FOLDER_NAME_LENGTH + 1) }, null]) {
      const answer = await call(NOTE_FOLDERS_PATH, { method: 'POST', cookie: alice.cookie, body });
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.code).toBe('invalid_input');
    }
  });
});

describe('filing', () => {
  it('replaces the set, lists a note under each folder it is in, and an empty set unfiles', async () => {
    const study = await folder(alice, `Study ${RUN}`);
    const prayer = await folder(alice, `Prayer ${RUN}`);
    const noteId = await ownNote(alice, 'To be filed.');

    const both = await file(alice, noteId, [study.id, prayer.id, prayer.id]);
    expect(both.status).toBe(200);
    expect(idsIn(both.body.folders, study.id)).toContain(noteId);
    expect(idsIn(both.body.folders, prayer.id)).toContain(noteId);

    const one = await file(alice, noteId, [prayer.id]);
    expect(idsIn(one.body.folders, study.id)).not.toContain(noteId);
    expect(idsIn(one.body.folders, prayer.id)).toContain(noteId);

    const none = await file(alice, noteId, []);
    expect(none.status).toBe(200);
    expect(none.body.folders.every((f) => !f.noteIds.includes(noteId))).toBe(true);
  });

  it('refuses another member’s note, a reply, a tombstone and a folder that is not the caller’s — each as not_found', async () => {
    const mine = await folder(alice, `Mine ${RUN}`);
    const bobs = await folder(bob, `Bobs ${RUN}`);
    const bobNote = await ownNote(bob, 'Bob wrote this.');
    const aliceNote = await ownNote(alice, 'Alice wrote this.');
    const reply = await insertNote(
      { recordingId: teaching, authorId: alice.id, visibility: 'public', text: 'A reply.', parentId: bobNote },
      handle,
    );

    const theirs = await file(alice, bobNote, [mine.id]);
    expect(theirs.status).toBe(404);
    expect(theirs.code).toBe('not_found');

    const replied = await file(alice, reply.id, [mine.id]);
    expect(replied.status).toBe(404);
    expect(replied.message).toBe(theirs.message);

    const nobodys = await file(alice, MADE_UP_ID, [mine.id]);
    expect(nobodys.status).toBe(404);
    expect(nobodys.message).toBe(theirs.message);

    const wrongFolder = await file(alice, aliceNote, [bobs.id]);
    expect(wrongFolder.status).toBe(404);
    expect(wrongFolder.code).toBe('not_found');
    // Nothing was written: Alice's note is in none of Bob's folders, and Bob's list is untouched.
    expect((await folders(bob)).every((f) => !f.noteIds.includes(aliceNote))).toBe(true);

    // A deleted note cannot be filed.
    const gone = await call(notePath(aliceNote), { method: 'DELETE', cookie: alice.cookie });
    expect(gone.status).toBe(200);
    const tomb = await file(alice, aliceNote, [mine.id]);
    expect(tomb.status).toBe(404);
    expect(tomb.message).toBe(theirs.message);

    const malformed = await call(noteFoldersPath(aliceNote), { method: 'PUT', cookie: alice.cookie, body: { folderIds: 'x' } });
    expect(malformed.status).toBe(400);
    expect(malformed.code).toBe('invalid_input');
  });

  it('deleting a folder leaves its notes; deleting a note takes it out of every folder', async () => {
    const keep = await folder(alice, `Keep ${RUN}`);
    const drop = await folder(alice, `Drop ${RUN}`);
    const noteId = await ownNote(alice, 'Filed twice.');
    expect((await file(alice, noteId, [keep.id, drop.id])).status).toBe(200);

    const afterFolder = await call<NoteFoldersPayload>(noteFolderPath(drop.id), { method: 'DELETE', cookie: alice.cookie });
    expect(afterFolder.status).toBe(200);
    expect(afterFolder.body.folders.some((f) => f.id === drop.id)).toBe(false);
    expect(idsIn(afterFolder.body.folders, keep.id)).toContain(noteId);
    // The note itself still stands.
    const standing = await call<{ note: { deleted: boolean } }>(notePath(noteId), { method: 'PATCH', cookie: alice.cookie, body: { text: 'Still here.' } });
    expect(standing.status).toBe(200);

    const removed = await call(notePath(noteId), { method: 'DELETE', cookie: alice.cookie });
    expect(removed.status).toBe(200);
    expect(idsIn(await folders(alice), keep.id)).not.toContain(noteId);
  });
});

describe('the ceiling', () => {
  it(`refuses the folder past ${MAX_NOTE_FOLDERS} with note_folders_full`, async () => {
    const carol = await signedIn('nf-carol');
    // Straight into the store, so the test is about the ceiling and not about a hundred requests.
    await Promise.all(
      Array.from({ length: MAX_NOTE_FOLDERS }, (_, index) =>
        insertNoteFolder({ userId: carol.id, name: `Folder ${index} ${RUN}` }, handle),
      ),
    );
    const over = await create(carol, `One more ${RUN}`);
    expect(over.status).toBe(409);
    expect(over.code).toBe('note_folders_full');
    expect((await folders(carol)).length).toBe(MAX_NOTE_FOLDERS);

    // Removing one makes room again.
    const [first] = await folders(carol);
    if (first === undefined) throw new Error('no folder to remove');
    await call(noteFolderPath(first.id), { method: 'DELETE', cookie: carol.cookie });
    expect((await create(carol, `One more ${RUN}`)).status).toBe(200);
  });
});
