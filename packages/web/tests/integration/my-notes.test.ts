import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  MY_NOTES_PATH,
  ROLE,
  isApiErrorBody,
  type MyNoteEntry,
  type MyNotesPayload,
} from '@thp/shared';
import {
  createDatabase,
  insertNote,
  insertRecording,
  insertSeries,
  setNoteReaction,
  setRecordingPublication,
  setRecordingSeries,
  softDeleteNote,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, signIn, type TestAccount } from '../support/accounts';

/**
 * **My notes over the API** — every note a member wrote, across every teaching, each inside its
 * thread, driven through the route the page uses.
 *
 * Four claims:
 *
 * 1. **The list is the caller's own, and whole.** Their private notes, their public notes and
 *    their replies, on every teaching; no session is `401`; another member's list never shows a
 *    private note that is not theirs.
 * 2. **A thread reads as it reads on the teaching.** A reply by another member comes under the
 *    member's note; a note the member replied to comes whole — the other member's note first,
 *    then every reply — and the thread is one entry however many of its notes are the member's.
 * 3. **The list follows the teaching's gates.** A note on an unpublished teaching is not listed
 *    and comes back when it is republished; a note the member deleted is gone; a thread whose
 *    parent was removed stands as a tombstone over the member's reply.
 * 4. **Newest written first**, and the entry says where: the teaching's title and its series.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let handle: DatabaseHandle;

interface Signed extends TestAccount {
  readonly cookie: string;
}

let alice: Signed;
let bob: Signed;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly body: T;
}

async function call<T>(path: string, cookie?: string): Promise<Answer<T>> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    headers: { accept: 'application/json', ...(cookie === undefined ? {} : { cookie }) },
  });
  const body = (await response.json().catch(() => undefined)) as unknown;
  return {
    status: response.status,
    code: isApiErrorBody(body) ? body.error.code : null,
    body: body as T,
  };
}

async function signedIn(label: string): Promise<Signed> {
  const account = await createAccount(databaseUrl, ROLE.member, `${label}-${RUN}`);
  const result = await signIn(baseUrl, account.email, account.password);
  if (result.cookie === null) throw new Error(`no cookie for ${account.email}`);
  return { ...account, cookie: result.cookie };
}

async function recording(title: string, published = true): Promise<string> {
  const row = await insertRecording(
    {
      originalMediaKey: `originals/my-notes-${title.replace(/\W+/g, '-')}-${RUN}.mp3`,
      title,
      recordedAt: '2026-10-01',
    },
    handle,
  );
  if (published) await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

async function mine(who: Signed): Promise<readonly MyNoteEntry[]> {
  const answer = await call<MyNotesPayload>(MY_NOTES_PATH, who.cookie);
  if (answer.status !== 200) throw new Error(`my notes refused ${answer.status}`);
  return answer.body.entries;
}

/** The entry whose thread root is this note, or a failure that names it. */
function entryFor(entries: readonly MyNoteEntry[], rootId: string): MyNoteEntry {
  const found = entries.find((one) => one.note.id === rootId);
  if (found === undefined) throw new Error(`no entry rooted at ${rootId}`);
  return found;
}

/** A moment apart, so "newest first" is a fact about `created_at` rather than a tie. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 15));
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 6 });
  alice = await signedIn('mn-alice');
  bob = await signedIn('mn-bob');
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('the list is the caller’s own, and whole', () => {
  it('lists private notes, public notes and replies across teachings, newest written first, with the teaching and its series', async () => {
    const study = await insertSeries({ title: `Study ${RUN}`, description: null }, handle);
    const first = await recording(`First ${RUN}`);
    const second = await recording(`Second ${RUN}`);
    await setRecordingSeries(second, study.id, handle);

    const secret = await insertNote(
      { recordingId: first, authorId: alice.id, visibility: 'private', text: 'For me.', timestampMs: 5_000 },
      handle,
    );
    await tick();
    const shared = await insertNote(
      { recordingId: second, authorId: alice.id, visibility: 'public', text: 'For everyone.', timestampMs: 65_000 },
      handle,
    );
    await tick();
    const bobs = await insertNote(
      { recordingId: second, authorId: bob.id, visibility: 'public', text: 'Bob wonders.', timestampMs: 9_000 },
      handle,
    );
    await tick();
    const bobsReply = await insertNote(
      { recordingId: second, authorId: bob.id, visibility: 'public', text: 'Bob answers Alice.', parentId: shared.id },
      handle,
    );
    await tick();
    const alicesReply = await insertNote(
      { recordingId: second, authorId: alice.id, visibility: 'public', text: 'Alice answers Bob.', parentId: bobs.id },
      handle,
    );
    await setNoteReaction(shared.id, bob.id, '🙏', handle);

    const entries = await mine(alice);
    const ours = entries.filter((one) =>
      [secret.id, shared.id, bobs.id].includes(one.note.id),
    );

    // Newest written first: Alice's reply to Bob is the latest thing she wrote.
    expect(ours.map((one) => one.note.id)).toEqual([bobs.id, shared.id, secret.id]);

    const own = entryFor(entries, secret.id);
    expect(own.visibility).toBe('private');
    expect(own.note.mine).toBe(true);
    expect(own.note.timestampMs).toBe(5_000);
    expect(own.note.replies).toEqual([]);
    expect(own.recording).toEqual({ id: first, title: `First ${RUN}`, series: null });

    // Her public note, with Bob's reply under it and his reaction counted.
    const open = entryFor(entries, shared.id);
    expect(open.visibility).toBe('public');
    expect(open.note.mine).toBe(true);
    expect(open.note.reactions).toEqual([{ emoji: '🙏', count: 1 }]);
    expect(open.note.replies.map((one) => [one.id, one.mine, one.text])).toEqual([
      [bobsReply.id, false, 'Bob answers Alice.'],
    ]);
    expect(open.recording.title).toBe(`Second ${RUN}`);
    expect(open.recording.series).toEqual({ id: study.id, title: `Study ${RUN}` });

    // The thread she replied to: Bob's note first, hers under it, the entry public.
    const answered = entryFor(entries, bobs.id);
    expect(answered.visibility).toBe('public');
    expect(answered.note.mine).toBe(false);
    expect(answered.note.authorDisplayName).toBe(bob.displayName);
    expect(answered.note.timestampMs).toBe(9_000);
    expect(answered.note.replies.map((one) => [one.id, one.mine])).toEqual([[alicesReply.id, true]]);
    expect(new Date(answered.writtenAt).toISOString()).toBe(answered.writtenAt);

    // Bob's list: his note, Alice's public note he replied to — and never her private one.
    const theirs = await mine(bob);
    expect(theirs.some((one) => one.note.id === secret.id)).toBe(false);
    expect(entryFor(theirs, bobs.id).note.mine).toBe(true);
    expect(entryFor(theirs, shared.id).note.mine).toBe(false);
    expect(entryFor(theirs, shared.id).note.replies.map((one) => one.mine)).toEqual([true]);

    const anonymous = await call(MY_NOTES_PATH);
    expect(anonymous.status).toBe(401);
  });
});

describe('the list follows the teaching’s gates', () => {
  it('leaves out an unpublished teaching’s note until it is republished, and a deleted note for good', async () => {
    const draft = await recording(`Draft ${RUN}`, false);
    const hidden = await insertNote(
      { recordingId: draft, authorId: alice.id, visibility: 'public', text: 'Too soon.', timestampMs: 1_000 },
      handle,
    );
    expect((await mine(alice)).some((one) => one.note.id === hidden.id)).toBe(false);

    await setRecordingPublication(draft, new Date(), handle);
    expect((await mine(alice)).some((one) => one.note.id === hidden.id)).toBe(true);

    await softDeleteNote(hidden.id, alice.id, handle);
    expect((await mine(alice)).some((one) => one.note.id === hidden.id)).toBe(false);
  });

  it('keeps a reply under a removed note, as a tombstone holding the thread', async () => {
    const where = await recording(`Removed ${RUN}`);
    const bobs = await insertNote(
      { recordingId: where, authorId: bob.id, visibility: 'public', text: 'Going away.', timestampMs: 2_000 },
      handle,
    );
    const reply = await insertNote(
      { recordingId: where, authorId: alice.id, visibility: 'public', text: 'Still here.', parentId: bobs.id },
      handle,
    );
    await softDeleteNote(bobs.id, bob.id, handle);

    const entry = entryFor(await mine(alice), bobs.id);
    expect(entry.note.deleted).toBe(true);
    expect(entry.note.text).toBe('');
    expect(entry.note.authorId).toBeNull();
    expect(entry.note.replies.map((one) => [one.id, one.mine])).toEqual([[reply.id, true]]);
  });
});
