import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  MEMBER_BLOCKS_PATH,
  NOTIFICATIONS_PATH,
  REACTIONS,
  ROLE,
  isApiErrorBody,
  memberBlockPath,
  noteReactionPath,
  recordingNotesPath,
  type BlockListPayload,
  type CreateNotePayload,
  type NoteView,
  type NotesPayload,
  type NotificationListPayload,
} from '@thp/shared';
import { createDatabase, insertRecording, setRecordingPublication, type DatabaseHandle } from '@thp/db';
import { closeTestDatabase, createAccount, signIn, type TestAccount } from '../support/accounts';
import { readWholeInbox } from '../support/inbox';

/**
 * **Member blocks over the API** — the list a member keeps, and what a block does to notes and
 * to notifications, driven through the routes a client would use.
 *
 * Five claims:
 *
 * 1. **The list is the caller's own.** `POST` and `DELETE` on `/users/me/blocks/:id` change it
 *    and answer it; `GET` reads it; who blocked *you* is listed nowhere. Yourself is
 *    `invalid_input`, nobody is `not_found`, a second press changes nothing, and any role may
 *    block any role.
 * 2. **Hiding is mutual and is the query's.** After A blocks B, the notes read answers A without
 *    B's notes, replies and reactions, and answers B without A's — and answers everybody else
 *    with both. The transport's markers derive from this same payload, so a note absent here is
 *    a tick absent there.
 * 3. **Acting across a block is refused with `blocked`**, from either side, while taking a
 *    reaction back is not.
 * 4. **Nothing is written to the centre about the other side** — not for the blocker about the
 *    blocked member, not the reverse — while a third member's reply still arrives.
 * 5. **Unblocking restores the read**, because nothing was deleted while the block stood.
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
let carol: Signed;
let admin: Signed;

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

async function recording(title: string): Promise<string> {
  const row = await insertRecording(
    {
      originalMediaKey: `originals/blocks-${title.replace(/\W+/g, '-')}-${RUN}.mp3`,
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

async function react(noteId: string, who: Signed) {
  return call(noteReactionPath(noteId), {
    method: 'PUT',
    cookie: who.cookie,
    body: { emoji: REACTIONS[0].emoji },
  });
}

async function notes(recordingId: string, who: Signed): Promise<readonly NoteView[]> {
  const answer = await call<NotesPayload>(recordingNotesPath(recordingId), { cookie: who.cookie });
  if (answer.status !== 200) throw new Error(`notes refused ${answer.status}`);
  return answer.body.notes;
}

async function blocks(who: Signed): Promise<readonly string[]> {
  const answer = await call<BlockListPayload>(MEMBER_BLOCKS_PATH, { cookie: who.cookie });
  if (answer.status !== 200) throw new Error(`blocks refused ${answer.status}`);
  return answer.body.blocked.map((one) => one.id);
}

async function block(who: Signed, target: string) {
  return call<BlockListPayload>(memberBlockPath(target), { method: 'POST', cookie: who.cookie });
}

async function unblock(who: Signed, target: string) {
  return call<BlockListPayload>(memberBlockPath(target), { method: 'DELETE', cookie: who.cookie });
}

/** This run's reply and reaction notices in somebody's centre, by who caused them. */
async function noticesFrom(who: Signed, actor: Signed): Promise<readonly string[]> {
  const inbox = await readWholeInbox(baseUrl, who.cookie);
  return inbox.notifications
    .filter((one) => one.kind === 'note_reply' || one.kind === 'note_reaction')
    .filter((one) => one.title.startsWith(actor.displayName))
    .map((one) => `${one.kind}:${one.body}`);
}

const ids = (list: readonly NoteView[]) => list.map((one) => one.id);
const replyIds = (list: readonly NoteView[], noteId: string) =>
  list.find((one) => one.id === noteId)?.replies.map((reply) => reply.id) ?? null;
const reactionCount = (list: readonly NoteView[], noteId: string) =>
  list.find((one) => one.id === noteId)?.reactions.reduce((sum, one) => sum + one.count, 0) ?? null;

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
  [alice, bob, carol, admin] = await Promise.all([
    signedIn('member', 'block-alice'),
    signedIn('member', 'block-bob'),
    signedIn('member', 'block-carol'),
    signedIn('admin', 'block-admin'),
  ]);
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('the blocked list', () => {
  it('refuses an anonymous caller at every method', async () => {
    expect((await call(MEMBER_BLOCKS_PATH, {})).status).toBe(401);
    expect((await call(memberBlockPath(bob.id), { method: 'POST' })).status).toBe(401);
    expect((await call(memberBlockPath(bob.id), { method: 'DELETE' })).status).toBe(401);
  });

  it('refuses yourself, refuses nobody, refuses a malformed id, and accepts anybody else', async () => {
    const self = await block(alice, alice.id);
    expect(self.status).toBe(400);
    expect(self.code).toBe('invalid_input');
    expect(self.message).toBe('You cannot block yourself.');

    const nobody = await block(alice, MADE_UP_ID);
    expect(nobody.status).toBe(404);
    expect(nobody.code).toBe('not_found');

    const malformed = await block(alice, 'not-an-id');
    expect(malformed.status).toBe(400);
    expect(malformed.code).toBe('invalid_input');

    expect(await blocks(alice)).toEqual([]);
  });

  it('is the caller’s own: a write answers it, a second press changes nothing, and the other side sees nothing', async () => {
    const first = await block(alice, bob.id);
    expect(first.status).toBe(200);
    expect(first.body.blocked.map((one) => one.id)).toEqual([bob.id]);
    expect(first.body.blocked[0]?.displayName).toBe(bob.displayName);
    expect(new Date(first.body.blocked[0]?.blockedAt ?? '').getTime()).not.toBeNaN();
    // Nothing about the blocked member beyond the name: no address, no picture.
    expect(JSON.stringify(first.body)).not.toContain(bob.email);

    const again = await block(alice, bob.id);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);

    expect(await blocks(alice)).toEqual([bob.id]);
    expect(await blocks(bob)).toEqual([]);

    expect((await unblock(alice, bob.id)).body.blocked).toEqual([]);
    expect(await blocks(alice)).toEqual([]);
  });

  it('lets any role block any role, and lists by display name', async () => {
    const memberOnAdmin = await block(bob, admin.id);
    expect(memberOnAdmin.status).toBe(200);
    const adminOnMember = await block(admin, carol.id);
    expect(adminOnMember.status).toBe(200);
    expect(await blocks(admin)).toEqual([carol.id]);

    await block(bob, carol.id);
    const listed = (await call<BlockListPayload>(MEMBER_BLOCKS_PATH, { cookie: bob.cookie })).body;
    const names = listed.blocked.map((one) => one.displayName);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
    expect(listed.blocked.map((one) => one.id).sort()).toEqual([admin.id, carol.id].sort());

    await unblock(bob, admin.id);
    await unblock(bob, carol.id);
    await unblock(admin, carol.id);
    // Unblocking somebody never blocked is the end state asked for.
    expect((await unblock(admin, bob.id)).status).toBe(200);
    expect((await unblock(admin, MADE_UP_ID)).status).toBe(200);
    expect((await unblock(admin, 'nonsense')).code).toBe('invalid_input');
  });
});

describe('what a block does', () => {
  let where: string;
  let bobsNote: string;
  let alicesNote: string;
  let carolsNote: string;
  let alicesReplyUnderBob: string;
  let bobsReplyUnderAlice: string;
  let bobsReplyUnderCarol: string;
  let carolsReplyUnderBob: string;
  let alicesNoticesFromBobBefore: readonly string[];
  let bobsNoticesFromAliceBefore: readonly string[];

  beforeAll(async () => {
    where = await recording(`Blocks ${RUN}`);
    bobsNote = (await write(where, bob, { text: `Bob ${RUN}`, visibility: 'public', timestampMs: 1_000 })).id;
    alicesNote = (await write(where, alice, { text: `Alice ${RUN}`, visibility: 'public', timestampMs: 2_000 })).id;
    carolsNote = (await write(where, carol, { text: `Carol ${RUN}`, visibility: 'public', timestampMs: 3_000 })).id;

    alicesReplyUnderBob = (await write(where, alice, { text: `Alice under Bob ${RUN}`, parentId: bobsNote })).id;
    carolsReplyUnderBob = (await write(where, carol, { text: `Carol under Bob ${RUN}`, parentId: bobsNote })).id;
    bobsReplyUnderAlice = (await write(where, bob, { text: `Bob under Alice ${RUN}`, parentId: alicesNote })).id;
    bobsReplyUnderCarol = (await write(where, bob, { text: `Bob under Carol ${RUN}`, parentId: carolsNote })).id;

    for (const [noteId, who] of [
      [alicesNote, bob],
      [alicesNote, carol],
      [carolsNote, alice],
      [carolsNote, bob],
      [bobsNote, alice],
    ] as const) {
      expect((await react(noteId, who)).status).toBe(200);
    }

    // What each side was already told before the block — these rows stay (the decision: a block
    // changes what is written from now on, and deletes nothing a member already has).
    alicesNoticesFromBobBefore = await noticesFrom(alice, bob);
    bobsNoticesFromAliceBefore = await noticesFrom(bob, alice);
    expect(alicesNoticesFromBobBefore.length).toBe(2);
    expect(bobsNoticesFromAliceBefore.length).toBe(2);

    expect((await block(alice, bob.id)).status).toBe(200);
  }, 120_000);

  it('hides the other side’s notes from each of them, thread and all, and from nobody else', async () => {
    const forAlice = await notes(where, alice);
    expect(ids(forAlice)).toEqual([alicesNote, carolsNote]);
    // Her own reply under Bob's note went with its parent; a reply is half a conversation.
    expect(JSON.stringify(forAlice)).not.toContain(alicesReplyUnderBob);

    const forBob = await notes(where, bob);
    expect(ids(forBob)).toEqual([bobsNote, carolsNote]);

    const forCarol = await notes(where, carol);
    expect(ids(forCarol)).toEqual([bobsNote, alicesNote, carolsNote]);

    // An admin is not a party to somebody else's block and reads everything, as before.
    const forAdmin = await notes(where, admin);
    expect(ids(forAdmin)).toEqual([bobsNote, alicesNote, carolsNote]);
  });

  it('leaves the other side’s replies out of threads both can still see', async () => {
    const forAlice = await notes(where, alice);
    expect(replyIds(forAlice, alicesNote)).toEqual([]);
    expect(replyIds(forAlice, carolsNote)).toEqual([]);

    const forBob = await notes(where, bob);
    expect(replyIds(forBob, bobsNote)).toEqual([carolsReplyUnderBob]);
    expect(replyIds(forBob, carolsNote)).toEqual([bobsReplyUnderCarol]);

    const forCarol = await notes(where, carol);
    expect(replyIds(forCarol, bobsNote)).toEqual([alicesReplyUnderBob, carolsReplyUnderBob]);
    expect(replyIds(forCarol, alicesNote)).toEqual([bobsReplyUnderAlice]);
  });

  it('counts only reactions from people each can see', async () => {
    const forAlice = await notes(where, alice);
    expect(reactionCount(forAlice, alicesNote)).toBe(1);
    expect(reactionCount(forAlice, carolsNote)).toBe(1);
    expect(forAlice.find((one) => one.id === carolsNote)?.myReaction).toBe(REACTIONS[0].emoji);

    const forBob = await notes(where, bob);
    expect(reactionCount(forBob, bobsNote)).toBe(0);
    expect(reactionCount(forBob, carolsNote)).toBe(1);

    const forCarol = await notes(where, carol);
    expect(reactionCount(forCarol, alicesNote)).toBe(2);
    expect(reactionCount(forCarol, carolsNote)).toBe(2);
    expect(reactionCount(forCarol, bobsNote)).toBe(1);
  });

  it('refuses a reply and a reaction across the block from either side, with blocked', async () => {
    const bobReplies = await call(recordingNotesPath(where), {
      method: 'POST',
      cookie: bob.cookie,
      body: { text: `Bob tries ${RUN}`, parentId: alicesNote },
    });
    expect(bobReplies.status).toBe(403);
    expect(bobReplies.code).toBe('blocked');
    expect(bobReplies.message).toBe('You cannot reply to this member’s notes.');

    const bobReacts = await react(alicesNote, bob);
    expect(bobReacts.status).toBe(403);
    expect(bobReacts.code).toBe('blocked');
    expect(bobReacts.message).toBe('You cannot react to this member’s notes.');

    const aliceReplies = await call(recordingNotesPath(where), {
      method: 'POST',
      cookie: alice.cookie,
      body: { text: `Alice tries ${RUN}`, parentId: bobsNote },
    });
    expect(aliceReplies.code).toBe('blocked');
    expect((await react(bobsNote, alice)).code).toBe('blocked');

    // Nothing was written: Carol still reads the threads as they were.
    const forCarol = await notes(where, carol);
    expect(replyIds(forCarol, alicesNote)).toEqual([bobsReplyUnderAlice]);
    expect(replyIds(forCarol, bobsNote)).toEqual([alicesReplyUnderBob, carolsReplyUnderBob]);
  });

  it('lets a reaction left before the block be taken back', async () => {
    const cleared = await call(noteReactionPath(alicesNote), { method: 'DELETE', cookie: bob.cookie });
    expect(cleared.status).toBe(200);
    expect(reactionCount(await notes(where, carol), alicesNote)).toBe(1);
  });

  it('writes nothing to either centre about the other side, while a third member still gets through', async () => {
    expect(await noticesFrom(alice, bob)).toEqual(alicesNoticesFromBobBefore);
    expect(await noticesFrom(bob, alice)).toEqual(bobsNoticesFromAliceBefore);

    await write(where, carol, { text: `Carol still reaches Alice ${RUN}`, parentId: alicesNote });
    expect(await noticesFrom(alice, carol)).toContain(`note_reply:Carol still reaches Alice ${RUN}`);
  });

  it('shows everything again once the block is lifted, and lets the sides act again', async () => {
    expect((await unblock(alice, bob.id)).status).toBe(200);

    const forAlice = await notes(where, alice);
    expect(ids(forAlice)).toEqual([bobsNote, alicesNote, carolsNote]);
    expect(replyIds(forAlice, bobsNote)).toEqual([alicesReplyUnderBob, carolsReplyUnderBob]);
    expect(replyIds(forAlice, alicesNote)?.includes(bobsReplyUnderAlice)).toBe(true);

    const reply = await call(recordingNotesPath(where), {
      method: 'POST',
      cookie: bob.cookie,
      body: { text: `Bob again ${RUN}`, parentId: alicesNote },
    });
    expect(reply.status).toBe(200);
    expect(await noticesFrom(alice, bob)).toContain(`note_reply:Bob again ${RUN}`);
  });
});
