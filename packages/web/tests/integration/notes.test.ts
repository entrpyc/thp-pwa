import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  MAX_NOTE_LENGTH,
  REACTIONS,
  ROLE,
  isApiErrorBody,
  notePath,
  notePinPath,
  noteReactionPath,
  recordingNotesPath,
  type CreateNotePayload,
  type NoteView,
  type NotesPayload,
} from '@thp/shared';
import {
  createDatabase,
  deactivateUser,
  insertRecording,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, signIn, type TestAccount } from '../support/accounts';
import { logOffset, waitForLogLines } from '../support/log-reader';

/**
 * **Writing and reading a teaching's notes over the API** (Tasks 1.4 and 1.5).
 *
 * What is asserted here is the server's half of the feature, and deliberately only that: every text,
 * position and publication rule holds whether or not an interface offered it, and the payload a
 * member is answered contains what they may see and nothing else.
 *
 * **The privacy assertions are the point of the file.** Three accounts write private notes on one
 * recording, and every read below is checked for the two it must not contain — including the read an
 * *admin* makes, because active-scope prd 3.1.9 makes no exception for one and the query it runs
 * through has no branch that could.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const logPath = inject('apiLogPath');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const MADE_UP_ID = '00000000-0000-4000-8000-000000000000';

let handle: DatabaseHandle;

interface Signed extends TestAccount {
  readonly cookie: string;
}

let author: Signed;
let other: Signed;
let admin: Signed;
let leaver: Signed;
/** A live member who writes nothing and reacts to nothing — the "somebody else" every read is checked against. */
let bystander: Signed;

let publishedId: string;
let unpublishedId: string;
/** A recording nobody has written on, so "empty" is distinguishable from "filtered". */
let bareId: string;

async function signedIn(role: 'admin' | 'member', label: string): Promise<Signed> {
  const account = await createAccount(databaseUrl, ROLE[role], `${label}-${RUN}`);
  const result = await signIn(baseUrl, account.email, account.password);
  if (result.cookie === null) throw new Error(`no cookie for ${account.email}`);
  return { ...account, cookie: result.cookie };
}

async function recording(title: string, published: boolean): Promise<string> {
  const row = await insertRecording(
    {
      originalMediaKey: `originals/notes-${title.replace(/\W+/g, '-')}-${RUN}.mp3`,
      title,
      recordedAt: '2026-08-16',
    },
    handle,
  );
  if (published) await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

async function post(recordingId: string, cookie: string, body: unknown) {
  const response = await fetch(`${baseUrl}${API_PREFIX}${recordingNotesPath(recordingId)}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

async function get(recordingId: string, cookie: string) {
  const response = await fetch(`${baseUrl}${API_PREFIX}${recordingNotesPath(recordingId)}`, {
    headers: { accept: 'application/json', cookie },
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

function errorCode(body: unknown): string | null {
  return isApiErrorBody(body) ? body.error.code : null;
}

function errorMessage(body: unknown): string {
  return isApiErrorBody(body) ? body.error.message : '';
}

/** Write a note and answer it, failing loudly rather than returning something unusable. */
async function write(
  recordingId: string,
  who: Signed,
  note: { text: string; visibility: 'private' | 'public'; timestampMs: number },
): Promise<NoteView> {
  const { status, body } = await post(recordingId, who.cookie, note);
  if (status !== 200) throw new Error(`write refused ${status}: ${JSON.stringify(body)}`);
  return (body as CreateNotePayload).note;
}

function notesOf(body: unknown): readonly NoteView[] {
  return (body as NotesPayload).notes;
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 4 });

  [author, other, admin, leaver, bystander] = await Promise.all([
    signedIn('member', 'note-author'),
    signedIn('member', 'note-other'),
    signedIn('admin', 'note-admin'),
    signedIn('member', 'note-leaver'),
    signedIn('member', 'note-bystander'),
  ]);

  publishedId = await recording(`Notes live ${RUN}`, true);
  unpublishedId = await recording(`Notes hidden ${RUN}`, false);
  bareId = await recording(`Notes bare ${RUN}`, true);
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================
// Task 1.4 — creating a note over the API
// =================================================================================================

describe('a member writes a note at a moment', () => {
  it('creates it from text, visibility and position, and answers the created note', async () => {
    const { status, body } = await post(publishedId, author.cookie, {
      text: 'The turn in the argument lands here.',
      visibility: 'public',
      timestampMs: 61_000,
    });

    expect(status).toBe(200);
    const { note } = body as CreateNotePayload;
    expect(note.text).toBe('The turn in the argument lands here.');
    expect(note.visibility).toBe('public');
    expect(note.timestampMs).toBe(61_000);
    expect(note.authorDisplayName).toBe(author.displayName);
    expect(note.mine).toBe(true);
    // No field on the wire says whether a note has been edited, so the key is absent entirely.
    expect(Object.keys(note)).not.toContain('editedAt');
    expect(Number.isNaN(Date.parse(note.createdAt))).toBe(false);

    // The created note is readable as itself, which is what makes the answer the list's shape
    // rather than a second one nothing else uses.
    const listed = notesOf((await get(publishedId, author.cookie)).body);
    expect(listed.map((one) => one.id)).toContain(note.id);
  });

  it('drops deletedBy on the way out, whatever else the payload carries', async () => {
    const { body } = await post(publishedId, author.cookie, {
      text: 'Who removed a note is not a reader’s business.',
      visibility: 'public',
      timestampMs: 62_000,
    });
    expect(JSON.stringify(body)).not.toContain('deletedBy');
    expect(JSON.stringify(body)).not.toContain('deleted_by');
  });

  it('writes a private note that its author gets back and nobody else does', async () => {
    const mine = await write(publishedId, author, {
      text: 'A private study note.',
      visibility: 'private',
      timestampMs: 5_000,
    });
    expect(mine.visibility).toBe('private');

    const forAuthor = notesOf((await get(publishedId, author.cookie)).body);
    expect(forAuthor.map((one) => one.id)).toContain(mine.id);

    const forOther = notesOf((await get(publishedId, other.cookie)).body);
    expect(forOther.map((one) => one.id)).not.toContain(mine.id);
  });

  it.each([
    ['nothing at all', ''],
    ['only spaces', '     '],
    ['only a newline', '\n\n'],
    ['only a tab', '\t'],
  ])('refuses text that is %s', async (_label, text) => {
    const { status, body } = await post(publishedId, author.cookie, {
      text,
      visibility: 'private',
      timestampMs: 1_000,
    });
    expect(status).toBe(400);
    expect(errorCode(body)).toBe('invalid_input');
  });

  it('refuses text over the ceiling rather than truncating it', async () => {
    const tooLong = 'x'.repeat(MAX_NOTE_LENGTH + 1);
    const { status, body } = await post(publishedId, author.cookie, {
      text: tooLong,
      visibility: 'private',
      timestampMs: 1_500,
    });
    expect(status).toBe(400);
    expect(errorCode(body)).toBe('invalid_input');

    // Truncation would have produced a note; a refusal produces none. Asserted against the list,
    // because "the response was a 400" and "nothing was written" are two different claims.
    const listed = notesOf((await get(publishedId, author.cookie)).body);
    expect(listed.some((one) => one.text.startsWith('xxxxxxxxxx'))).toBe(false);
  });

  it('accepts text at exactly the ceiling, padding included', async () => {
    const exact = 'y'.repeat(MAX_NOTE_LENGTH);
    const note = await write(publishedId, author, {
      // The padding is what makes this a ceiling measured after trimming rather than before.
      text: `   ${exact}   `,
      visibility: 'private',
      timestampMs: 1_750,
    });
    expect(note.text).toHaveLength(MAX_NOTE_LENGTH);
  });

  it('refuses a position below zero', async () => {
    const { status, body } = await post(publishedId, author.cookie, {
      text: 'Before the beginning.',
      visibility: 'private',
      timestampMs: -1,
    });
    expect(status).toBe(400);
    expect(errorCode(body)).toBe('invalid_input');
  });

  it('treats a second note at an already-noted position as an ordinary write', async () => {
    const first = await write(publishedId, author, {
      text: 'First thought at this moment.',
      visibility: 'public',
      timestampMs: 90_000,
    });
    const second = await write(publishedId, author, {
      text: 'Second thought at the same moment.',
      visibility: 'public',
      timestampMs: 90_000,
    });

    expect(second.id).not.toBe(first.id);
    const listed = notesOf((await get(publishedId, author.cookie)).body);
    const atThatMoment = listed.filter((one) => one.timestampMs === 90_000);
    expect(atThatMoment.map((one) => one.id)).toEqual([first.id, second.id]);
  });

  it('refuses a visibility nobody offers', async () => {
    const { status, body } = await post(publishedId, author.cookie, {
      text: 'Somewhere in between.',
      visibility: 'group-only',
      timestampMs: 2_000,
    });
    expect(status).toBe(400);
    expect(errorCode(body)).toBe('invalid_input');
  });

  it('refuses a write to an unpublished teaching with 5.1.4’s message', async () => {
    const { status, body } = await post(unpublishedId, author.cookie, {
      text: 'Written into a teaching that went away.',
      visibility: 'public',
      timestampMs: 3_000,
    });
    expect(status).toBe(404);
    expect(errorCode(body)).toBe('not_found');
    expect(errorMessage(body)).toBe(
      "This teaching isn't available any more, so the note can't be saved.",
    );
  });

  it('answers an id that never existed exactly as it answers an unpublished one', async () => {
    const invented = await post(MADE_UP_ID, author.cookie, {
      text: 'About nothing.',
      visibility: 'public',
      timestampMs: 0,
    });
    expect(invented.status).toBe(404);
    expect(errorCode(invented.body)).toBe('not_found');
  });

  it('lets an admin write on exactly the terms a member does', async () => {
    const note = await write(publishedId, admin, {
      text: 'An admin writing as a member of the group.',
      visibility: 'public',
      timestampMs: 70_000,
    });
    expect(note.authorDisplayName).toBe(admin.displayName);

    const forMember = notesOf((await get(publishedId, other.cookie)).body);
    expect(forMember.map((one) => one.id)).toContain(note.id);
  });
});

// =================================================================================================
// Task 1.5 — reading a recording's notes over the API
// =================================================================================================

describe('a member reads a teaching’s notes', () => {
  /** A recording of its own, so the ordering assertions are not at the mercy of the writes above. */
  let orderedId: string;
  let atOneMoment: readonly string[];

  beforeAll(async () => {
    orderedId = await recording(`Notes ordered ${RUN}`, true);

    // Written out of position order on purpose: an endpoint that answered in insertion order would
    // pass an "ordered" assertion made against a fixture written in order.
    await write(orderedId, author, { text: 'Third', visibility: 'public', timestampMs: 30_000 });
    await write(orderedId, other, { text: 'First', visibility: 'public', timestampMs: 10_000 });
    await write(orderedId, author, { text: 'Second', visibility: 'public', timestampMs: 20_000 });

    // Three at one moment, so the tie-break is a claim with something to break on.
    const tied: string[] = [];
    for (const label of ['tie-a', 'tie-b', 'tie-c']) {
      const note = await write(orderedId, author, {
        text: label,
        visibility: 'public',
        timestampMs: 40_000,
      });
      tied.push(note.id);
    }
    atOneMoment = tied;
  }, 120_000);

  it('answers in one payload ordered by position, ascending', async () => {
    const { status, body } = await get(orderedId, author.cookie);
    expect(status).toBe(200);

    const notes = notesOf(body);
    // Every entry in this list is a top-level note, so every position is a real number — a null
    // here would mean a reply had reached a list ordered by a column it does not have.
    const positions = notes.map((one) => one.timestampMs ?? Number.NaN);
    expect(positions.some(Number.isNaN)).toBe(false);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(notes.slice(0, 3).map((one) => one.text)).toEqual(['First', 'Second', 'Third']);
  });

  it('breaks a tie at one position by creation time, oldest first, and repeats it', async () => {
    const first = notesOf((await get(orderedId, author.cookie)).body);
    const again = notesOf((await get(orderedId, author.cookie)).body);

    const tiedIn = (notes: readonly NoteView[]) =>
      notes.filter((one) => one.timestampMs === 40_000).map((one) => one.id);

    expect(tiedIn(first)).toEqual(atOneMoment);
    // Stable across reloads is half of "total": the same order, not merely a valid one.
    expect(tiedIn(again)).toEqual(atOneMoment);
  });

  it('carries each note’s id, position, author name, written time and text — and no edit marker', async () => {
    const notes = notesOf((await get(orderedId, author.cookie)).body);
    const first = notes[0];
    if (first === undefined) throw new Error('the fixture wrote no notes');

    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.timestampMs).toBe(10_000);
    expect(first.authorDisplayName).toBe(other.displayName);
    expect(first.text).toBe('First');
    expect(Object.keys(first)).not.toContain('editedAt');
    expect(Number.isNaN(Date.parse(first.createdAt))).toBe(false);
  });

  it('refuses a read of an unpublished teaching rather than answering an empty list', async () => {
    const { status, body } = await get(unpublishedId, author.cookie);
    expect(status).toBe(404);
    expect(errorCode(body)).toBe('not_found');
    // The distinction the criterion is actually about: a published teaching nobody has written on
    // *is* an empty list, and these two answers must not look alike.
    const bare = await get(bareId, author.cookie);
    expect(bare.status).toBe(200);
    expect(notesOf(bare.body)).toEqual([]);
  });

  it('keeps another member’s private note out of the payload, for a member and for an admin', async () => {
    const stage = await recording(`Notes private ${RUN}`, true);
    const hidden = await write(stage, author, {
      text: 'Nobody else reads this.',
      visibility: 'private',
      timestampMs: 1_000,
    });
    const shared = await write(stage, author, {
      text: 'Everybody reads this.',
      visibility: 'public',
      timestampMs: 2_000,
    });

    for (const reader of [other, admin]) {
      const { status, body } = await get(stage, reader.cookie);
      expect(status).toBe(200);

      const ids = notesOf(body).map((one) => one.id);
      expect(ids, `${reader.email} saw the private note`).not.toContain(hidden.id);
      expect(ids, `${reader.email} lost the public note`).toContain(shared.id);
      // Absent from the payload, not hidden in it — the text must not travel either.
      expect(JSON.stringify(body)).not.toContain('Nobody else reads this.');
    }

    const forAuthor = notesOf((await get(stage, author.cookie)).body);
    expect(forAuthor.map((one) => one.id)).toEqual([hidden.id, shared.id]);
  });

  it('marks the reader’s own notes and only those as theirs', async () => {
    const stage = await recording(`Notes mine ${RUN}`, true);
    const theirs = await write(stage, author, {
      text: 'Written by the author.',
      visibility: 'public',
      timestampMs: 1_000,
    });
    const someone = await write(stage, other, {
      text: 'Written by somebody else.',
      visibility: 'public',
      timestampMs: 2_000,
    });

    const forAuthor = notesOf((await get(stage, author.cookie)).body);
    expect(forAuthor.find((one) => one.id === theirs.id)?.mine).toBe(true);
    expect(forAuthor.find((one) => one.id === someone.id)?.mine).toBe(false);

    const forOther = notesOf((await get(stage, other.cookie)).body);
    expect(forOther.find((one) => one.id === theirs.id)?.mine).toBe(false);
    expect(forOther.find((one) => one.id === someone.id)?.mine).toBe(true);
  });

  it('returns a note by a deactivated account unchanged, under the same display name', async () => {
    const stage = await recording(`Notes leaver ${RUN}`, true);
    const written = await write(stage, leaver, {
      text: 'Written before the account was closed.',
      visibility: 'public',
      timestampMs: 4_000,
    });

    await deactivateUser(leaver.id, handle);

    const notes = notesOf((await get(stage, other.cookie)).body);
    const found = notes.find((one) => one.id === written.id);
    expect(found).toBeDefined();
    expect(found?.text).toBe('Written before the account was closed.');
    expect(found?.authorDisplayName).toBe(leaver.displayName);
  });
});

// =================================================================================================
// Groups 3–6 — replies, reactions, editing, deleting and moderation over the API
// =================================================================================================

/**
 * **The server's half of the rest of the scope.**
 *
 * Everything below is asserted through real HTTP against a real database, and every refusal is
 * driven **from more than one actor** wherever the requirement names more than one — a rule that
 * refuses a stranger and quietly permits the author is the failure mode these tests exist for, and
 * it passes any test that only ever asks one person.
 *
 * Each recording is made fresh where the assertion is about a *set* (a list, a thread, the pins on
 * a teaching), so one test cannot pass because of a row another test happened to leave behind.
 */

async function call(path: string, cookie: string, method: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

const patchNote = (id: string, who: Signed, body: unknown) =>
  call(notePath(id), who.cookie, 'PATCH', body);
const deleteNote = (id: string, who: Signed) => call(notePath(id), who.cookie, 'DELETE');
const react = (id: string, who: Signed, emoji: string) =>
  call(noteReactionPath(id), who.cookie, 'PUT', { emoji });
const unreact = (id: string, who: Signed) => call(noteReactionPath(id), who.cookie, 'DELETE');
const pin = (id: string, who: Signed) => call(notePinPath(id), who.cookie, 'PUT');
const unpin = (id: string, who: Signed) => call(notePinPath(id), who.cookie, 'DELETE');

/** Write a reply and answer it, failing loudly rather than returning something unusable. */
async function replyTo(
  recordingId: string,
  who: Signed,
  parentId: string,
  text: string,
): Promise<NoteView> {
  const { status, body } = await post(recordingId, who.cookie, { text, parentId });
  if (status !== 200) throw new Error(`reply refused ${status}: ${JSON.stringify(body)}`);
  return (body as CreateNotePayload).note;
}

/** One note out of a reader's whole payload, or `undefined` if they cannot see it. */
async function seenBy(recordingId: string, who: Signed, noteId: string) {
  return notesOf((await get(recordingId, who.cookie)).body).find((one) => one.id === noteId);
}

// -------------------------------------------------------------------------------------------
// Task 3.1 — replies over the API

describe('a member replies to a public note', () => {
  it('creates a reply with that parent, no position, and public visibility', async () => {
    const where = await recording(`Reply create ${RUN}`, true);
    const parent = await write(where, author, {
      text: 'The question this raises.',
      visibility: 'public',
      timestampMs: 10_000,
    });

    const { status, body } = await post(where, other.cookie, {
      text: 'And the answer it gives.',
      parentId: parent.id,
    });

    expect(status).toBe(200);
    const { note } = body as CreateNotePayload;
    expect(note.text).toBe('And the answer it gives.');
    // A reply belongs to its parent's moment rather than to one of its own (3.3.2).
    expect(note.timestampMs).toBeNull();
    expect(note.visibility).toBe('public');
    expect(note.authorDisplayName).toBe(other.displayName);
  });

  it('applies the same text rules the composer’s notes get, unchanged', async () => {
    const where = await recording(`Reply text ${RUN}`, true);
    const parent = await write(where, author, {
      text: 'A note to answer.',
      visibility: 'public',
      timestampMs: 1_000,
    });

    for (const text of ['', '   ', '\n', 'x'.repeat(MAX_NOTE_LENGTH + 1)]) {
      const { status, body } = await post(where, other.cookie, { text, parentId: parent.id });
      expect(status, JSON.stringify(text.slice(0, 20))).toBe(400);
      expect(errorCode(body)).toBe('invalid_input');
    }

    // And the padded version of a real reply is accepted and stored trimmed, which is what makes
    // the refusals above about the text rather than about replies.
    const kept = await replyTo(where, other, parent.id, '   Trimmed on the way in.   ');
    expect(kept.text).toBe('Trimmed on the way in.');
  });

  it('refuses a reply that asks to be private, and stores every reply public', async () => {
    const where = await recording(`Reply private ${RUN}`, true);
    const parent = await write(where, author, {
      text: 'Public, and answerable.',
      visibility: 'public',
      timestampMs: 1_000,
    });

    const refused = await post(where, other.cookie, {
      text: 'Only for me.',
      parentId: parent.id,
      visibility: 'private',
    });
    expect(refused.status).toBe(400);
    expect(errorCode(refused.body)).toBe('invalid_input');

    // Asking for public, and asking for nothing, both store public — there is no third answer.
    const asked = await replyTo(where, other, parent.id, 'Said out loud.');
    expect(asked.visibility).toBe('public');
  });

  it('refuses a reply to a reply rather than re-pointing it at the grandparent', async () => {
    const where = await recording(`Reply depth ${RUN}`, true);
    const parent = await write(where, author, {
      text: 'The top of the thread.',
      visibility: 'public',
      timestampMs: 1_000,
    });
    const reply = await replyTo(where, other, parent.id, 'One level down.');

    const { status, body } = await post(where, author.cookie, {
      text: 'Two levels down.',
      parentId: reply.id,
    });
    expect(status).toBe(400);
    expect(errorCode(body)).toBe('invalid_input');

    // And nothing was quietly filed under the grandparent instead, which is the silent failure
    // this refusal exists to prevent.
    const listed = await seenBy(where, author, parent.id);
    expect(listed?.replies.map((one) => one.text)).toEqual(['One level down.']);
  });

  it('refuses a reply to a private note for every actor, its own author included', async () => {
    const where = await recording(`Reply to private ${RUN}`, true);
    const secret = await write(where, author, {
      text: 'Kept to myself.',
      visibility: 'private',
      timestampMs: 1_000,
    });

    for (const who of [author, other, admin]) {
      const { status, body } = await post(where, who.cookie, {
        text: 'Answering a note nobody else can read.',
        parentId: secret.id,
      });
      expect(status, who.email).toBe(400);
      expect(errorCode(body), who.email).toBe('invalid_input');
    }
  });

  it('refuses a parent that belongs to a different teaching', async () => {
    const here = await recording(`Reply here ${RUN}`, true);
    const elsewhere = await recording(`Reply elsewhere ${RUN}`, true);
    const parent = await write(elsewhere, author, {
      text: 'On another teaching entirely.',
      visibility: 'public',
      timestampMs: 1_000,
    });

    const { status, body } = await post(here, other.cookie, {
      text: 'Filed under the wrong teaching.',
      parentId: parent.id,
    });
    expect(status).toBe(400);
    expect(errorCode(body)).toBe('invalid_input');
  });

  it('carries each note’s thread oldest first, and no reply as a top-level entry', async () => {
    const where = await recording(`Reply order ${RUN}`, true);
    const parent = await write(where, author, {
      text: 'The note being answered.',
      visibility: 'public',
      timestampMs: 5_000,
    });
    const second = await write(where, author, {
      text: 'A note with nothing under it.',
      visibility: 'public',
      timestampMs: 9_000,
    });

    // Written in order, one at a time, so `created_at` is genuinely ordered.
    for (const text of ['First said', 'Second said', 'Third said']) {
      await replyTo(where, other, parent.id, text);
    }

    const listed = notesOf((await get(where, author.cookie)).body);
    // Three replies exist and the list still has exactly two entries: a reply has no position, so
    // it has no place in a list ordered by one (3.3.2).
    expect(listed.map((one) => one.id)).toEqual([parent.id, second.id]);
    expect(listed[0]?.replies.map((one) => one.text)).toEqual([
      'First said',
      'Second said',
      'Third said',
    ]);
    // A note with no replies carries an empty thread rather than a missing field (3.3.7).
    expect(listed[1]?.replies).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
// Tasks 4.2 and 4.3 — reactions over the API

describe('a member reacts to a public note', () => {
  it('sets a reaction, and a second PUT replaces it rather than adding one', async () => {
    const where = await recording(`React set ${RUN}`, true);
    const note = await write(where, author, {
      text: 'Something to respond to.',
      visibility: 'public',
      timestampMs: 1_000,
    });

    expect((await react(note.id, other, '🙏')).status).toBe(200);
    expect((await seenBy(where, other, note.id))?.reactions).toEqual([{ emoji: '🙏', count: 1 }]);

    expect((await react(note.id, other, '🔥')).status).toBe(200);
    const after = await seenBy(where, other, note.id);
    // One row, not two — and it is the *second* choice, which is what tells replacement from a
    // first reaction that happened to survive.
    expect(after?.reactions).toEqual([{ emoji: '🔥', count: 1 }]);
    expect(after?.myReaction).toBe('🔥');
  });

  it('clears a reaction, and clearing when none is set succeeds', async () => {
    const where = await recording(`React clear ${RUN}`, true);
    const note = await write(where, author, {
      text: 'React and take it back.',
      visibility: 'public',
      timestampMs: 1_000,
    });

    await react(note.id, other, '💡');
    expect((await unreact(note.id, other)).status).toBe(200);
    const after = await seenBy(where, other, note.id);
    expect(after?.reactions).toEqual([]);
    expect(after?.myReaction).toBeNull();

    // Nothing to clear is the state the member asked for, so it is not an error (3.4.4).
    expect((await unreact(note.id, other)).status).toBe(200);
  });

  it('refuses a glyph outside the vocabulary, and stores the vocabulary’s exact string', async () => {
    const where = await recording(`React vocabulary ${RUN}`, true);
    const note = await write(where, author, {
      text: 'Six, and only six.',
      visibility: 'public',
      timestampMs: 1_000,
    });

    for (const bad of ['🦆', 'praying', '', '❤']) {
      const { status, body } = await react(note.id, other, bad);
      // `❤` is the one that matters: it is the variation-selector-free spelling of a glyph that
      // *is* in the set, and accepting it would store two strings counted as two reactions.
      expect(status, bad).toBe(400);
      expect(errorCode(body), bad).toBe('invalid_input');
    }

    const loved = REACTIONS.find((one) => one.name === 'loved')?.emoji as string;
    expect((await react(note.id, other, loved)).status).toBe(200);
    expect((await seenBy(where, other, note.id))?.reactions).toEqual([{ emoji: loved, count: 1 }]);
  });

  it('counts two members reacting at once, and settles one member’s burst on their last', async () => {
    const where = await recording(`React race ${RUN}`, true);
    const note = await write(where, author, {
      text: 'Two hands at the same moment.',
      visibility: 'public',
      timestampMs: 1_000,
    });

    const both = await Promise.all([react(note.id, author, '👏'), react(note.id, other, '👏')]);
    expect(both.map((one) => one.status)).toEqual([200, 200]);
    expect((await seenBy(where, author, note.id))?.reactions).toEqual([{ emoji: '👏', count: 2 }]);

    // One member, three presses in a row: the key holds them to one row whichever order they land.
    await Promise.all([
      react(note.id, other, '🙏'),
      react(note.id, other, '😢'),
      react(note.id, other, '🔥'),
    ]);
    const settled = await seenBy(where, author, note.id);
    const total = settled?.reactions.reduce((sum, one) => sum + one.count, 0);
    // Two members, two reactions — never four, whatever the burst chose.
    expect(total).toBe(2);
  });

  it('refuses a reaction to a private note for every actor, its own author included', async () => {
    const where = await recording(`React private ${RUN}`, true);
    const secret = await write(where, author, {
      text: 'Nobody responds to this.',
      visibility: 'private',
      timestampMs: 1_000,
    });

    for (const who of [author, other, admin]) {
      const { status, body } = await react(secret.id, who, '🙏');
      expect(status, who.email).toBe(400);
      expect(errorCode(body), who.email).toBe('invalid_input');
    }
  });

  it('takes a reaction on a reply on exactly the same terms as on a note', async () => {
    const where = await recording(`React reply ${RUN}`, true);
    const parent = await write(where, author, {
      text: 'The note.',
      visibility: 'public',
      timestampMs: 1_000,
    });
    const reply = await replyTo(where, other, parent.id, 'The reply.');

    expect((await react(reply.id, author, '💡')).status).toBe(200);
    const listed = await seenBy(where, author, parent.id);
    expect(listed?.replies[0]?.reactions).toEqual([{ emoji: '💡', count: 1 }]);
    expect(listed?.replies[0]?.myReaction).toBe('💡');
  });

  it('lets a member react to their own public note', async () => {
    const where = await recording(`React own ${RUN}`, true);
    const mine = await write(where, author, {
      text: 'My own note.',
      visibility: 'public',
      timestampMs: 1_000,
    });

    expect((await react(mine.id, author, '🙏')).status).toBe(200);
    expect((await seenBy(where, author, mine.id))?.myReaction).toBe('🙏');
  });

  it('carries a count per emoji, only for emoji somebody chose, plus the reader’s own', async () => {
    const where = await recording(`React payload ${RUN}`, true);
    const note = await write(where, author, {
      text: 'Counted per glyph.',
      visibility: 'public',
      timestampMs: 1_000,
    });

    await react(note.id, author, '🙏');
    await react(note.id, other, '🙏');
    await react(note.id, admin, '🔥');

    const forOther = await seenBy(where, other, note.id);
    expect(forOther?.reactions).toEqual([
      { emoji: '🙏', count: 2 },
      { emoji: '🔥', count: 1 },
    ]);
    // Nobody chose the other four, and they are absent rather than present at zero (3.4.5).
    expect(forOther?.reactions).toHaveLength(2);
    expect(forOther?.myReaction).toBe('🙏');

    // The reader's own is the *reader's*, so the same rows answer differently per member.
    expect((await seenBy(where, admin, note.id))?.myReaction).toBe('🔥');
    expect((await seenBy(where, bystander, note.id))?.myReaction).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------
// Task 5.1 — editing

describe('an author edits their own note', () => {
  it('changes the text and marks the note nowhere, with the text rules applying unchanged', async () => {
    const where = await recording(`Edit text ${RUN}`, true);
    const note = await write(where, author, {
      text: 'The first wording.',
      visibility: 'public',
      timestampMs: 1_000,
    });

    expect((await patchNote(note.id, author, { text: '  The better wording.  ' })).status).toBe(200);

    const after = await seenBy(where, author, note.id);
    expect(after?.text).toBe('The better wording.');
    // An edited note reads exactly like one nobody has touched: no field on the wire tells them
    // apart, so nothing renders an **edited** marker.
    expect(Object.keys(after ?? {})).not.toContain('editedAt');
    expect(JSON.stringify(await get(where, author.cookie))).not.toContain('editedAt');
    // The previous text is not returned anywhere in the payload, and there is no history.
    expect(JSON.stringify(await get(where, author.cookie))).not.toContain('The first wording.');

    for (const text of ['', '   ', 'x'.repeat(MAX_NOTE_LENGTH + 1)]) {
      expect((await patchNote(note.id, author, { text })).status).toBe(400);
    }
  });

  it('edits a reply on the same terms', async () => {
    const where = await recording(`Edit reply ${RUN}`, true);
    const parent = await write(where, author, {
      text: 'A note.',
      visibility: 'public',
      timestampMs: 1_000,
    });
    const reply = await replyTo(where, other, parent.id, 'First try.');

    expect((await patchNote(reply.id, other, { text: 'Second try.' })).status).toBe(200);
    const listed = await seenBy(where, author, parent.id);
    expect(listed?.replies[0]?.text).toBe('Second try.');
    expect(Object.keys(listed?.replies[0] ?? {})).not.toContain('editedAt');
  });

  it('refuses an edit of somebody else’s note — to a member and to an admin alike', async () => {
    const where = await recording(`Edit others ${RUN}`, true);
    const note = await write(where, author, {
      text: 'My words.',
      visibility: 'public',
      timestampMs: 1_000,
    });

    for (const who of [other, admin]) {
      const { status, body } = await patchNote(note.id, who, { text: 'Somebody else’s words.' });
      expect(status, who.email).toBe(403);
      expect(errorCode(body), who.email).toBe('forbidden');
    }
    // Moderation is deletion, never rewriting — so the words are still the author's (3.6.2).
    expect((await seenBy(where, author, note.id))?.text).toBe('My words.');
  });

  it('changes neither the timestamp nor the visibility, in either direction', async () => {
    const where = await recording(`Edit fields ${RUN}`, true);
    const open = await write(where, author, {
      text: 'Public and staying that way.',
      visibility: 'public',
      timestampMs: 7_000,
    });
    const shut = await write(where, author, {
      text: 'Private and staying that way.',
      visibility: 'private',
      timestampMs: 8_000,
    });

    await patchNote(open.id, author, { text: 'Still public.', visibility: 'private', timestampMs: 1 });
    await patchNote(shut.id, author, { text: 'Still private.', visibility: 'public', timestampMs: 2 });

    const after = notesOf((await get(where, author.cookie)).body);
    const openAfter = after.find((one) => one.id === open.id);
    const shutAfter = after.find((one) => one.id === shut.id);

    expect(openAfter?.visibility).toBe('public');
    expect(openAfter?.timestampMs).toBe(7_000);
    // Lowering a public note would strand its replies; raising a private one would publish text
    // written in confidence. Neither field is accepted, so neither happens.
    expect(shutAfter?.visibility).toBe('private');
    expect(shutAfter?.timestampMs).toBe(8_000);
    // The text half of the same request still took effect, so the refusal is about those fields.
    expect(openAfter?.text).toBe('Still public.');
  });
});

// -------------------------------------------------------------------------------------------
// Task 5.2 — deleting, and the tombstone

describe('an author deletes their own note', () => {
  it('removes a note with no replies from the payload entirely', async () => {
    const where = await recording(`Delete bare ${RUN}`, true);
    const note = await write(where, author, {
      text: 'Gone without trace.',
      visibility: 'public',
      timestampMs: 1_000,
    });

    expect((await deleteNote(note.id, author)).status).toBe(200);
    expect(await seenBy(where, author, note.id)).toBeUndefined();
    expect(await seenBy(where, other, note.id)).toBeUndefined();
  });

  it('leaves a tombstone that keeps its position and its replies', async () => {
    const where = await recording(`Delete threaded ${RUN}`, true);
    const note = await write(where, author, {
      text: 'The parent, about to go.',
      visibility: 'public',
      timestampMs: 42_000,
    });
    await replyTo(where, other, note.id, 'The conversation that survives it.');

    await deleteNote(note.id, author);

    const tombstone = await seenBy(where, other, note.id);
    expect(tombstone?.deleted).toBe(true);
    // Its moment is kept, which is what keeps the replies reachable from where they belong (3.5.4).
    expect(tombstone?.timestampMs).toBe(42_000);
    expect(tombstone?.replies.map((one) => one.text)).toEqual([
      'The conversation that survives it.',
    ]);
  });

  it('returns a deleted note’s text to nobody — not its author, not an admin', async () => {
    const where = await recording(`Delete text ${RUN}`, true);
    const note = await write(where, author, {
      text: 'A sentence nobody should read again.',
      visibility: 'public',
      timestampMs: 1_000,
    });
    await replyTo(where, other, note.id, 'Keeping the tombstone standing.');

    await deleteNote(note.id, author);

    for (const who of [author, other, admin]) {
      const payload = await get(where, who.cookie);
      expect(JSON.stringify(payload), who.email).not.toContain('A sentence nobody should read');
      expect((await seenBy(where, who, note.id))?.text, who.email).toBe('');
    }
  });

  it('removes one reply and leaves its parent and its siblings alone', async () => {
    const where = await recording(`Delete reply ${RUN}`, true);
    const parent = await write(where, author, {
      text: 'The note.',
      visibility: 'public',
      timestampMs: 1_000,
    });
    const doomed = await replyTo(where, other, parent.id, 'This one goes.');
    await replyTo(where, other, parent.id, 'This one stays.');

    expect((await deleteNote(doomed.id, other)).status).toBe(200);

    const after = await seenBy(where, author, parent.id);
    expect(after?.deleted).toBe(false);
    expect(after?.text).toBe('The note.');
    // A deleted reply is not returned at all — there is no reply tombstone (3.3.10).
    expect(after?.replies.map((one) => one.text)).toEqual(['This one stays.']);
  });

  it('removes a private note entirely, since it can have no replies', async () => {
    const where = await recording(`Delete private ${RUN}`, true);
    const secret = await write(where, author, {
      text: 'Mine, and now gone.',
      visibility: 'private',
      timestampMs: 1_000,
    });

    await deleteNote(secret.id, author);
    expect(await seenBy(where, author, secret.id)).toBeUndefined();
  });

  it('refuses a member deleting another member’s note', async () => {
    const where = await recording(`Delete others ${RUN}`, true);
    const note = await write(where, author, {
      text: 'Not yours to remove.',
      visibility: 'public',
      timestampMs: 1_000,
    });

    const { status, body } = await deleteNote(note.id, other);
    expect(status).toBe(403);
    expect(errorCode(body)).toBe('forbidden');
    expect((await seenBy(where, author, note.id))?.deleted).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// Task 5.4 — acting on a note removed underneath you

describe('a note removed underneath the member', () => {
  it('answers note_removed to an edit, a delete, a reply and a reaction alike', async () => {
    const where = await recording(`Removed underneath ${RUN}`, true);
    const note = await write(where, author, {
      text: 'About to go.',
      visibility: 'public',
      timestampMs: 1_000,
    });
    await replyTo(where, other, note.id, 'Holding the tombstone up.');
    await deleteNote(note.id, author);

    const attempts = [
      ['edit', await patchNote(note.id, author, { text: 'Too late.' })],
      ['delete', await deleteNote(note.id, author)],
      ['reply', await post(where, other.cookie, { text: 'Too late.', parentId: note.id })],
      ['react', await react(note.id, other, '🙏')],
      ['unreact', await unreact(note.id, other)],
    ] as const;

    for (const [what, result] of attempts) {
      // 409 and its own code — distinct from `invalid_input`, because the request was well-formed
      // against an affordance that was real when it was rendered.
      expect(result.status, what).toBe(409);
      expect(errorCode(result.body), what).toBe('note_removed');
    }

    // And nothing was resurrected or silently written by any of them.
    const after = await seenBy(where, other, note.id);
    expect(after?.deleted).toBe(true);
    expect(after?.text).toBe('');
    expect(after?.reactions).toEqual([]);
  });

  it('says the same about a reply that went away, and does not file the answer anyway', async () => {
    const where = await recording(`Removed reply ${RUN}`, true);
    const parent = await write(where, author, {
      text: 'The note.',
      visibility: 'public',
      timestampMs: 1_000,
    });
    const reply = await replyTo(where, other, parent.id, 'About to go.');
    await deleteNote(reply.id, other);

    const refused = await react(reply.id, author, '🙏');
    expect(refused.status).toBe(409);
    expect(errorCode(refused.body)).toBe('note_removed');
    expect((await seenBy(where, author, parent.id))?.replies).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
// Task 6.1 — admin deletion, logged

describe('an admin moderates a public note', () => {
  it('removes a note and a reply they did not write, with the same tombstone behaviour', async () => {
    const where = await recording(`Moderate ${RUN}`, true);
    const bare = await write(where, author, {
      text: 'Should not stand.',
      visibility: 'public',
      timestampMs: 1_000,
    });
    const threaded = await write(where, author, {
      text: 'Should not stand either.',
      visibility: 'public',
      timestampMs: 2_000,
    });
    const reply = await replyTo(where, other, threaded.id, 'A reply that survives it.');
    const spare = await replyTo(where, other, threaded.id, 'A reply that does not.');

    expect((await deleteNote(bare.id, admin)).status).toBe(200);
    expect((await deleteNote(threaded.id, admin)).status).toBe(200);
    expect((await deleteNote(spare.id, admin)).status).toBe(200);

    // Exactly what an author's own deletion does (5.2.3): no replies, gone; replies, a tombstone.
    expect(await seenBy(where, other, bare.id)).toBeUndefined();
    const tombstone = await seenBy(where, other, threaded.id);
    expect(tombstone?.deleted).toBe(true);
    expect(tombstone?.replies.map((one) => one.id)).toEqual([reply.id]);
  });

  it('tells the author nothing about who removed it', async () => {
    const where = await recording(`Moderate silent ${RUN}`, true);
    const note = await write(where, author, {
      text: 'Taken down by somebody.',
      visibility: 'public',
      timestampMs: 1_000,
    });
    await replyTo(where, other, note.id, 'Holding it up.');

    await deleteNote(note.id, admin);

    // The author reads exactly what everybody else reads (3.5.8), and `deletedBy` is nowhere on
    // the wire however the payload is built.
    const payload = await get(where, author.cookie);
    expect(JSON.stringify(payload)).not.toContain(admin.id);
    expect(JSON.stringify(payload)).not.toContain('deletedBy');
    expect((await seenBy(where, author, note.id))?.deleted).toBe(true);
  });

  it('logs the moderation against the admin, and does not log their own deletion', async () => {
    const offset = logOffset(logPath);
    const where = await recording(`Moderate log ${RUN}`, true);
    const theirs = await write(where, author, {
      text: 'Somebody else’s.',
      visibility: 'public',
      timestampMs: 1_000,
    });
    const own = await write(where, admin, {
      text: 'The admin’s own.',
      visibility: 'public',
      timestampMs: 2_000,
    });

    await deleteNote(theirs.id, admin);
    await deleteNote(own.id, admin);

    const lines = await waitForLogLines(logPath, offset, (found) =>
      found.some(
        (line) => line.message === 'note.moderate' && line['target'] === `note:${theirs.id}`,
      ),
    );

    const logged = lines.find(
      (one) => one.message === 'note.moderate' && one['target'] === `note:${theirs.id}`,
    );
    expect(logged).toMatchObject({
      actorId: admin.id,
      actorEmail: admin.email,
      action: 'note.moderate',
    });
    expect(typeof logged?.correlationId).toBe('string');

    // The admin's **own** note took the owned path, so it is not on the moderation record (6.1.4).
    expect(
      lines.some((one) => one.message === 'note.moderate' && one['target'] === `note:${own.id}`),
    ).toBe(false);
  });

  it('refuses an admin the deletion of a private note, and never shows them one', async () => {
    const where = await recording(`Moderate private ${RUN}`, true);
    const secret = await write(where, author, {
      text: 'An admin has no business here.',
      visibility: 'private',
      timestampMs: 1_000,
    });

    expect((await deleteNote(secret.id, admin)).status).toBeGreaterThanOrEqual(400);
    expect((await seenBy(where, author, secret.id))?.deleted).toBe(false);

    // The absence is the query's condition, not a branch in the moderation path — so the note is
    // not in the admin's payload at all, text and existence alike.
    const payload = await get(where, admin.cookie);
    expect(JSON.stringify(payload)).not.toContain('An admin has no business here.');
    expect(notesOf(payload.body).map((one) => one.id)).not.toContain(secret.id);
  });
});

// -------------------------------------------------------------------------------------------
// Tasks 6.2 and 6.3 — pinning and unpinning

describe('an admin raises notes above the list', () => {
  it('pins any number on one recording, adding rather than replacing', async () => {
    const where = await recording(`Pin many ${RUN}`, true);
    const first = await write(where, author, {
      text: 'Raised first.',
      visibility: 'public',
      timestampMs: 1_000,
    });
    const second = await write(where, author, {
      text: 'Raised second.',
      visibility: 'public',
      timestampMs: 2_000,
    });

    expect((await pin(first.id, admin)).status).toBe(200);
    expect((await pin(second.id, admin)).status).toBe(200);

    const listed = notesOf((await get(where, other.cookie)).body);
    // Both, not the second alone — pinning adds to the set (3.6.6).
    expect(listed.filter((one) => one.pinned).map((one) => one.id)).toEqual([first.id, second.id]);
  });

  it('succeeds and changes nothing when the note is already pinned', async () => {
    const where = await recording(`Pin twice ${RUN}`, true);
    const note = await write(where, author, {
      text: 'Pinned, and pinned again.',
      visibility: 'public',
      timestampMs: 1_000,
    });

    await pin(note.id, admin);
    expect((await pin(note.id, admin)).status).toBe(200);
    expect((await seenBy(where, other, note.id))?.pinned).toBe(true);
  });

  it('refuses a member’s pin and a member’s unpin', async () => {
    const where = await recording(`Pin member ${RUN}`, true);
    const note = await write(where, author, {
      text: 'Not a member’s to raise.',
      visibility: 'public',
      timestampMs: 1_000,
    });

    expect((await pin(note.id, other)).status).toBe(403);
    expect((await pin(note.id, author)).status).toBe(403);
    await pin(note.id, admin);
    expect((await unpin(note.id, other)).status).toBe(403);
    expect((await seenBy(where, other, note.id))?.pinned).toBe(true);
  });

  it('refuses a reply, a private note and a note on an unpublished teaching', async () => {
    const where = await recording(`Pin shape ${RUN}`, true);
    const parent = await write(where, author, {
      text: 'A note.',
      visibility: 'public',
      timestampMs: 1_000,
    });
    const reply = await replyTo(where, other, parent.id, 'A reply, which is no moment.');
    const secret = await write(where, author, {
      text: 'Private.',
      visibility: 'private',
      timestampMs: 2_000,
    });

    expect((await pin(reply.id, admin)).status).toBe(400);
    expect((await pin(secret.id, admin)).status).toBe(400);

    // And on a teaching that has been taken down, the publication gate refuses first (3.6.10).
    const goingDown = await recording(`Pin unpublished ${RUN}`, true);
    const stranded = await write(goingDown, author, {
      text: 'On a teaching about to go.',
      visibility: 'public',
      timestampMs: 1_000,
    });
    await setRecordingPublication(goingDown, null, handle);
    expect((await pin(stranded.id, admin)).status).toBe(404);
  });

  it('logs every pin and every unpin against the acting admin', async () => {
    const offset = logOffset(logPath);
    const where = await recording(`Pin log ${RUN}`, true);
    const note = await write(where, author, {
      text: 'Raised, then lowered.',
      visibility: 'public',
      timestampMs: 1_000,
    });

    await pin(note.id, admin);
    await unpin(note.id, admin);

    const wanted = ['note.pin', 'note.unpin'];
    const lines = await waitForLogLines(logPath, offset, (found) =>
      wanted.every((message) =>
        found.some((line) => line.message === message && line['target'] === `note:${note.id}`),
      ),
    );

    for (const message of wanted) {
      const line = lines.find(
        (one) => one.message === message && one['target'] === `note:${note.id}`,
      );
      expect(line, message).toBeDefined();
      expect(line).toMatchObject({ actorId: admin.id, actorEmail: admin.email, action: message });
      expect(typeof line?.correlationId).toBe('string');
    }
  });

  it('unpins one and leaves every other pin in place', async () => {
    const where = await recording(`Unpin one ${RUN}`, true);
    const staying = await write(where, author, {
      text: 'Stays up.',
      visibility: 'public',
      timestampMs: 1_000,
    });
    const going = await write(where, author, {
      text: 'Comes down.',
      visibility: 'public',
      timestampMs: 2_000,
    });
    await pin(staying.id, admin);
    await pin(going.id, admin);

    expect((await unpin(going.id, admin)).status).toBe(200);

    const listed = notesOf((await get(where, other.cookie)).body);
    expect(listed.filter((one) => one.pinned).map((one) => one.id)).toEqual([staying.id]);
    // And the unpinned note is still in the list, at its own position (3.6.7).
    expect(listed.map((one) => one.id)).toContain(going.id);

    // Unpinning the last leaves the recording in the state every recording starts in.
    await unpin(staying.id, admin);
    expect(notesOf((await get(where, other.cookie)).body).some((one) => one.pinned)).toBe(false);
  });

  it('clears the deleted note’s pin and no other, from either kind of delete', async () => {
    const where = await recording(`Pin delete ${RUN}`, true);
    const byAuthor = await write(where, author, {
      text: 'Deleted by its author.',
      visibility: 'public',
      timestampMs: 1_000,
    });
    const byAdmin = await write(where, author, {
      text: 'Deleted by an admin.',
      visibility: 'public',
      timestampMs: 2_000,
    });
    const untouched = await write(where, author, {
      text: 'Left alone.',
      visibility: 'public',
      timestampMs: 3_000,
    });
    for (const note of [byAuthor, byAdmin, untouched]) await pin(note.id, admin);
    // Both doomed notes keep a reply, so each leaves a tombstone that *could* have shown as pinned.
    await replyTo(where, other, byAuthor.id, 'Holding it up.');
    await replyTo(where, other, byAdmin.id, 'Holding it up.');

    await deleteNote(byAuthor.id, author);
    await deleteNote(byAdmin.id, admin);

    const listed = notesOf((await get(where, other.cookie)).body);
    // A recording never shows a pinned tombstone (3.6.9), whichever hand did the deleting.
    expect(listed.find((one) => one.id === byAuthor.id)?.pinned).toBe(false);
    expect(listed.find((one) => one.id === byAdmin.id)?.pinned).toBe(false);
    // And the pin that had nothing to do with either is exactly where it was.
    expect(listed.find((one) => one.id === untouched.id)?.pinned).toBe(true);
  });
});
