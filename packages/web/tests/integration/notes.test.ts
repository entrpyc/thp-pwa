import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  MAX_NOTE_LENGTH,
  ROLE,
  isApiErrorBody,
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

  [author, other, admin, leaver] = await Promise.all([
    signedIn('member', 'note-author'),
    signedIn('member', 'note-other'),
    signedIn('admin', 'note-admin'),
    signedIn('member', 'note-leaver'),
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
    expect(note.editedAt).toBeNull();
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
    const positions = notes.map((one) => one.timestampMs);
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

  it('carries each note’s id, position, author name, written time, editedAt and text', async () => {
    const notes = notesOf((await get(orderedId, author.cookie)).body);
    const first = notes[0];
    if (first === undefined) throw new Error('the fixture wrote no notes');

    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.timestampMs).toBe(10_000);
    expect(first.authorDisplayName).toBe(other.displayName);
    expect(first.text).toBe('First');
    expect(first.editedAt).toBeNull();
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
