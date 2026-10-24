import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  MAX_NOTE_IMAGES,
  NOTE_IMAGE_UPLOADS_PATH,
  NOTIFICATIONS_PATH,
  ROLE,
  isApiErrorBody,
  noteImagePath,
  notePath,
  recordingNotesPath,
  type CreateNotePayload,
  type NoteImageRef,
  type NotePayload,
  type NoteView,
  type NotesPayload,
  type NotificationListPayload,
  type UploadGrantPayload,
} from '@thp/shared';
import { createDatabase, insertRecording, setRecordingPublication, type DatabaseHandle } from '@thp/db';
import { closeTestDatabase, createAccount, signIn, type TestAccount } from '../support/accounts';
import { readWholeInbox } from '../support/inbox';
import { webpBytes } from '../support/artwork';

/**
 * **Pictures on notes over the API** ([3.12.22](docs/project/prd.md)–[3.12.25](docs/project/prd.md)):
 * grant → `PUT` → write, with the API on both ends of an upload it never sees.
 *
 * Six claims:
 *
 * 1. **A note carries its pictures and answers them as URLs, never keys**, in the order written,
 *    each with its description; a reply does the same; a note of pictures alone needs no words,
 *    and the bell says “Photo” for it.
 * 2. **The server believes the store.** A key nothing was uploaded to, a key under another prefix,
 *    a pending reference, a fourth picture, a description over the ceiling and a key another note
 *    already carries are each refused in words, and no row is written.
 * 3. **Editing** keeps by id, adds by key and removes what is not listed; a kept id that is not
 *    the note's is refused; an edit with no `images` leaves the pictures alone.
 * 4. **Removing one picture** is the author's, or an admin's on a public note — not another
 *    member's, and not the last picture of a note with no words.
 * 5. **Deleting the note** takes the pictures with it: the tombstone shows none.
 * 6. **No session** is `401` at the grant.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let handle: DatabaseHandle;

interface Signed extends TestAccount {
  readonly cookie: string;
}

let author: Signed;
let other: Signed;
let admin: Signed;
let recordingId: string;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly message: string;
  readonly body: T;
}

async function call<T>(path: string, init: { method?: string; cookie?: string; body?: unknown }): Promise<Answer<T>> {
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

/** Grant and the real `PUT`, exactly as a browser makes them. Answers the key. */
async function uploaded(who: Signed, size = 4_096): Promise<string> {
  const grant = await call<UploadGrantPayload>(NOTE_IMAGE_UPLOADS_PATH, {
    method: 'POST',
    cookie: who.cookie,
    body: { filename: 'page.webp', contentType: 'image/webp', size },
  });
  if (grant.status !== 200) throw new Error(`grant refused ${grant.status}: ${grant.message}`);
  expect(grant.body.key.startsWith('note-images/')).toBe(true);
  const sent = await fetch(grant.body.url, {
    method: 'PUT',
    headers: { 'content-type': grant.body.contentType },
    body: webpBytes(size),
  });
  expect(sent.status).toBe(200);
  return grant.body.key;
}

async function write(who: Signed, body: Record<string, unknown>) {
  return call<CreateNotePayload>(recordingNotesPath(recordingId), { method: 'POST', cookie: who.cookie, body });
}

async function written(who: Signed, body: Record<string, unknown>): Promise<NoteView> {
  const answer = await write(who, body);
  if (answer.status !== 200) throw new Error(`write refused ${answer.status}: ${answer.message}`);
  return answer.body.note;
}

async function listed(who: Signed): Promise<readonly NoteView[]> {
  const answer = await call<NotesPayload>(recordingNotesPath(recordingId), { cookie: who.cookie });
  if (answer.status !== 200) throw new Error(`list refused ${answer.status}`);
  return answer.body.notes;
}

async function find(who: Signed, noteId: string): Promise<NoteView | undefined> {
  const notes = await listed(who);
  return notes.find((one) => one.id === noteId) ?? notes.flatMap((one) => one.replies).find((one) => one.id === noteId);
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
  [author, other, admin] = await Promise.all([
    signedIn('member', 'img-author'),
    signedIn('member', 'img-other'),
    signedIn('admin', 'img-admin'),
  ]);
  const row = await insertRecording(
    { originalMediaKey: `originals/note-images-${RUN}.mp3`, title: `Pictures ${RUN}`, recordedAt: '2026-10-01' },
    handle,
  );
  await setRecordingPublication(row.id, new Date(), handle);
  recordingId = row.id;
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('a note carries its pictures', () => {
  it('answers them as signed URLs in order with their descriptions, on a note and on a reply, and needs no words', async () => {
    const first = await uploaded(author);
    const second = await uploaded(author);
    const images: NoteImageRef[] = [{ key: first, alt: 'A page of notes' }, { key: second }];
    const note = await written(author, { text: `With pictures ${RUN}`, visibility: 'public', timestampMs: 1_000, images });

    expect(note.images).toHaveLength(2);
    expect(note.images[0]?.alt).toBe('A page of notes');
    expect(note.images[1]?.alt).toBeNull();
    for (const image of note.images) {
      // A signed grant — the store's URL carries the object's path, as a cover's does, and the
      // signature is what makes it a grant rather than a key: nothing in the view is a bare key.
      expect(image.url).toMatch(/^https?:\/\//);
      expect(image.url).toContain('X-Amz-Signature=');
      expect(Object.keys(image).sort()).toEqual(['alt', 'id', 'url']);
    }

    const read = await find(other, note.id);
    expect(read?.images.map((one) => one.alt)).toEqual(['A page of notes', null]);

    // A reply with a picture and no words tells the author "Photo".
    const replyKey = await uploaded(other);
    const reply = await written(other, { text: '', parentId: note.id, images: [{ key: replyKey }] });
    expect(reply.text).toBe('');
    expect(reply.images).toHaveLength(1);
    const inbox = await readWholeInbox(baseUrl, author.cookie);
    const notice = inbox.notifications.find((one) => one.kind === 'note_reply' && one.body === 'Photo');
    expect(notice).toBeDefined();

    // Pictures alone on a top-level note, too.
    const alone = await written(author, { visibility: 'private', timestampMs: 2_000, images: [{ key: await uploaded(author) }] });
    expect(alone.text).toBe('');
    expect(alone.images).toHaveLength(1);
  });

  it('believes the store and refuses what it cannot read back, a fourth picture, a long description, a pending reference and a reused key', async () => {
    const base = { text: 'x', visibility: 'public', timestampMs: 0 };
    expect((await write(author, { ...base, images: [{ key: 'note-images/00000000-0000-4000-8000-000000000000.webp' }] })).code).toBe('invalid_input');
    expect((await write(author, { ...base, images: [{ key: 'avatars/x.webp' }] })).code).toBe('invalid_input');
    expect((await write(author, { ...base, images: [{ pending: 'p1' }] })).code).toBe('invalid_input');
    expect((await write(author, { ...base, images: 'nope' })).code).toBe('invalid_input');
    expect((await write(author, { visibility: 'public', timestampMs: 0 })).code).toBe('invalid_input');

    const keys = await Promise.all(Array.from({ length: MAX_NOTE_IMAGES + 1 }, () => uploaded(author)));
    expect((await write(author, { ...base, images: keys.map((key) => ({ key })) })).code).toBe('invalid_input');
    expect((await write(author, { ...base, images: [{ key: keys[0], alt: 'x'.repeat(201) }] })).code).toBe('invalid_input');
    expect((await write(author, { ...base, images: [{ key: keys[0] }, { key: keys[0] }] })).code).toBe('invalid_input');

    const kept = await written(author, { ...base, images: [{ key: keys[0] }] });
    expect(kept.images).toHaveLength(1);
    // The same key again — by its owner or by anybody — belongs to a note already.
    expect((await write(author, { ...base, images: [{ key: keys[0] }] })).code).toBe('invalid_input');
    expect((await write(other, { ...base, images: [{ key: keys[0] }] })).code).toBe('invalid_input');

    const anonymous = await call(NOTE_IMAGE_UPLOADS_PATH, { method: 'POST', body: { filename: 'x', contentType: 'image/webp', size: 10 } });
    expect(anonymous.status).toBe(401);
  });
});

describe('editing and removing', () => {
  it('keeps by id, adds by key, removes the unlisted, leaves the pictures alone when unmentioned, and refuses a foreign id', async () => {
    const a = await uploaded(author);
    const b = await uploaded(author);
    const note = await written(author, { text: 'edit me', visibility: 'public', timestampMs: 3_000, images: [{ key: a }, { key: b, alt: 'second' }] });
    const [imageA, imageB] = note.images;

    const c = await uploaded(author);
    const edited = await call<NotePayload>(notePath(note.id), {
      method: 'PATCH',
      cookie: author.cookie,
      body: { text: 'edited', images: [{ id: imageB!.id, alt: 'second, renamed' }, { key: c, alt: 'third' }] },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.note.images.map((one) => one.alt)).toEqual(['second, renamed', 'third']);
    expect(edited.body.note.images.some((one) => one.id === imageA!.id)).toBe(false);

    const textOnly = await call<NotePayload>(notePath(note.id), { method: 'PATCH', cookie: author.cookie, body: { text: 'words again' } });
    expect(textOnly.body.note.images).toHaveLength(2);

    const foreign = await call(notePath(note.id), { method: 'PATCH', cookie: author.cookie, body: { text: 'x', images: [{ id: '00000000-0000-4000-8000-000000000000' }] } });
    expect(foreign.code).toBe('invalid_input');

    // The words may go once a picture stays; they may not go when nothing would be left.
    const wordless = await call<NotePayload>(notePath(note.id), { method: 'PATCH', cookie: author.cookie, body: { text: '', images: [{ id: edited.body.note.images[0]!.id }] } });
    expect(wordless.status).toBe(200);
    expect(wordless.body.note.text).toBe('');
    expect((await call(notePath(note.id), { method: 'PATCH', cookie: author.cookie, body: { text: '', images: [] } })).code).toBe('invalid_input');
  });

  it('lets the author or an admin take one picture off, not another member, and never the last picture of a wordless note', async () => {
    const note = await written(author, {
      text: 'two pictures',
      visibility: 'public',
      timestampMs: 4_000,
      images: [{ key: await uploaded(author) }, { key: await uploaded(author) }],
    });
    const [first, second] = note.images;

    expect((await call(noteImagePath(note.id, first!.id), { method: 'DELETE', cookie: other.cookie })).code).toBe('forbidden');
    const own = await call<NotePayload>(noteImagePath(note.id, first!.id), { method: 'DELETE', cookie: author.cookie });
    expect(own.status).toBe(200);
    expect(own.body.note.images.map((one) => one.id)).toEqual([second!.id]);
    expect((await call(noteImagePath(note.id, first!.id), { method: 'DELETE', cookie: author.cookie })).code).toBe('not_found');

    const moderated = await call<NotePayload>(noteImagePath(note.id, second!.id), { method: 'DELETE', cookie: admin.cookie });
    expect(moderated.status).toBe(200);
    expect(moderated.body.note.images).toEqual([]);
    expect(moderated.body.note.text).toBe('two pictures');

    const wordless = await written(author, { text: '', visibility: 'public', timestampMs: 5_000, images: [{ key: await uploaded(author) }] });
    expect((await call(noteImagePath(wordless.id, wordless.images[0]!.id), { method: 'DELETE', cookie: author.cookie })).code).toBe('invalid_input');

    // An admin does not reach a private note's pictures — refused the way moderating a private
    // note's words is, with the same sentence's code.
    const hidden = await written(author, { text: 'mine', visibility: 'private', timestampMs: 6_000, images: [{ key: await uploaded(author) }] });
    expect((await call(noteImagePath(hidden.id, hidden.images[0]!.id), { method: 'DELETE', cookie: admin.cookie })).code).toBe('invalid_input');
    expect((await find(author, hidden.id))?.images).toHaveLength(1);
  });

  it('takes the pictures down with the note', async () => {
    const note = await written(author, { text: 'going', visibility: 'public', timestampMs: 7_000, images: [{ key: await uploaded(author) }] });
    await written(other, { text: 'a reply so the tombstone stands', parentId: note.id });
    const gone = await call<NotePayload>(notePath(note.id), { method: 'DELETE', cookie: author.cookie });
    expect(gone.status).toBe(200);
    expect(gone.body.note.deleted).toBe(true);
    expect(gone.body.note.images).toEqual([]);
    expect((await find(other, note.id))?.images).toEqual([]);
  });
});
