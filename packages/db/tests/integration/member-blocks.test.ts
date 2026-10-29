import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  createDatabase,
  deleteMemberBlock,
  deleteUserAccount,
  findMemberBlock,
  insertMemberBlock,
  insertNote,
  insertRecording,
  insertUser,
  isBlockedEitherWay,
  listBlockedMembers,
  listNotesForReader,
  listReactionsForNotes,
  listRepliesForNotes,
  setNoteReaction,
  softDeleteNote,
  type DatabaseHandle,
} from '@thp/db';
import { REACTIONS, ROLE } from '@thp/shared';

/**
 * **Member blocks at the database** — the table, and the one predicate every read of member
 * content states.
 *
 * Four claims:
 *
 * 1. **The table holds a pair once, refuses a self-block, and goes with either account.** The
 *    primary key, the check and the two cascades, each driven rather than read off the schema.
 * 2. **The predicate is symmetric.** `isBlockedEitherWay(a, b)` and `(b, a)` answer the same,
 *    whichever of them placed the block, and a member is never blocked from themselves.
 * 3. **The three reads for a reader state it.** A note, a reply and a reaction by a member the
 *    reader has a block with are absent for *both* members of the pair and present for everybody
 *    else — including the reader's own reply under a note that is now hidden, which goes with its
 *    parent.
 * 4. **A tombstone held open only by a blocked member's reply stands for nobody it would stand
 *    over an empty thread for.**
 *
 * The suite shares a database with every other file, so every account here is this file's own.
 */

const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let handle: DatabaseHandle;
let seeded = 0;

async function newUser(label: string): Promise<string> {
  seeded += 1;
  const row = await insertUser(
    {
      email: `block-db-${label}-${RUN}-${seeded}@example.test`,
      passwordHash: 'not-a-real-hash',
      displayName: `${label} ${RUN}`,
      role: ROLE.member,
    },
    handle,
  );
  return row.id;
}

async function newRecording(title: string): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    {
      originalMediaKey: `originals/block-db-${RUN}-${seeded}.mp3`,
      title: `${title} ${RUN}`,
      recordedAt: '2026-10-01',
    },
    handle,
  );
  return row.id;
}

async function topLevel(recordingId: string, authorId: string, timestampMs: number) {
  return insertNote(
    { recordingId, authorId, visibility: 'public', text: `note ${RUN}`, timestampMs },
    handle,
  );
}

async function reply(recordingId: string, authorId: string, parentId: string) {
  return insertNote(
    { recordingId, authorId, visibility: 'public', text: `reply ${RUN}`, parentId },
    handle,
  );
}

const EMOJI = REACTIONS[0].emoji;

beforeAll(() => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
});

afterAll(async () => {
  await handle?.close();
});

// =================================================================================================

describe('the member_block table', () => {
  it('holds a pair once: the second insert writes nothing and the row is unchanged', async () => {
    const [alice, bob] = await Promise.all([newUser('Alice'), newUser('Bob')]);

    expect(await insertMemberBlock(alice, bob, handle)).toBe(true);
    const first = await findMemberBlock(alice, bob, handle);
    expect(first?.blockerId).toBe(alice);
    expect(first?.blockedId).toBe(bob);

    expect(await insertMemberBlock(alice, bob, handle)).toBe(false);
    expect(await findMemberBlock(alice, bob, handle)).toEqual(first);
    // The reverse pair is its own row — direction is the fact the list reads.
    expect(await findMemberBlock(bob, alice, handle)).toBeNull();
  });

  it('refuses a self-block at the database, whatever the service forgot', async () => {
    const alice = await newUser('Alice');
    // Drizzle wraps the driver's error as a `cause`, so the constraint's name is one level down.
    const refused = await insertMemberBlock(alice, alice, handle).then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(refused).not.toBeNull();
    expect(String(refused?.cause ?? refused)).toMatch(/member_block_not_self/);
  });

  it('is deleted with either account, and an unblock of nothing is a quiet success', async () => {
    const [alice, bob, carol] = await Promise.all([newUser('Alice'), newUser('Bob'), newUser('Carol')]);
    await insertMemberBlock(alice, bob, handle);
    await insertMemberBlock(carol, alice, handle);

    expect(await deleteMemberBlock(bob, alice, handle)).toBe(false);
    expect(await findMemberBlock(alice, bob, handle)).not.toBeNull();

    await handle.sql`delete from "user" where id = ${alice}`;
    expect(await findMemberBlock(alice, bob, handle)).toBeNull();
    expect(await findMemberBlock(carol, alice, handle)).toBeNull();
    expect(await listBlockedMembers(carol, handle)).toEqual([]);
  });

  it('survives the blocked member deleting their account: the block follows the placeholder (finding 15)', async () => {
    // The public notes move to the placeholder; without this a reader who had blocked the author
    // would see them come back as "Removed member" (docs/security-audit-2026-10-28.md, finding 15).
    const [leaver, reader, other] = await Promise.all([newUser('Leaver'), newUser('Reader'), newUser('Other')]);
    const where = await newRecording('Leaving');
    const leaversNote = (await topLevel(where, leaver, 1_000)).id;
    const othersNote = (await topLevel(where, other, 2_000)).id;
    await insertMemberBlock(reader, leaver, handle);
    await insertMemberBlock(leaver, other, handle);

    const result = await deleteUserAccount(leaver, handle);
    expect(result.outcome).toBe('applied');
    if (result.outcome !== 'applied') return;
    const placeholder = result.value.placeholderId;
    expect(result.value.retainedBlocks).toBe(1);

    // The reader's block now names the placeholder, and the leaver's own block is gone.
    expect(await findMemberBlock(reader, placeholder, handle)).not.toBeNull();
    expect((await listBlockedMembers(reader, handle)).map((row) => row.id)).toEqual([placeholder]);
    expect(await handle.sql`select 1 from member_block where blocker_id = ${leaver} or blocked_id = ${leaver}`).toHaveLength(0);

    // And the note, now the placeholder's, stays out of the reader's list and in everybody else's.
    expect((await listNotesForReader(where, reader, handle)).map((row) => row.id)).toEqual([othersNote]);
    expect((await listNotesForReader(where, other, handle)).map((row) => row.id)).toEqual([leaversNote, othersNote]);
  });

  it('lists only the blocker’s own direction, by display name', async () => {
    const [alice, bob, carol] = await Promise.all([newUser('Alice'), newUser('Zed'), newUser('Carol')]);
    await insertMemberBlock(alice, bob, handle);
    await insertMemberBlock(alice, carol, handle);
    await insertMemberBlock(bob, alice, handle);

    const listed = await listBlockedMembers(alice, handle);
    expect(listed.map((row) => row.id)).toEqual([carol, bob]);
    expect(listed.map((row) => row.displayName)).toEqual([`Carol ${RUN}`, `Zed ${RUN}`]);
    expect(listed.every((row) => row.blockedAt instanceof Date)).toBe(true);
    // Carol blocked nobody; that Alice blocked Carol is Alice's list, not Carol's.
    expect(await listBlockedMembers(carol, handle)).toEqual([]);
  });
});

describe('the predicate', () => {
  it('answers the same whichever side placed the block, and false for a member alone', async () => {
    const [alice, bob, carol] = await Promise.all([newUser('Alice'), newUser('Bob'), newUser('Carol')]);
    expect(await isBlockedEitherWay(alice, bob, handle)).toBe(false);

    await insertMemberBlock(alice, bob, handle);
    expect(await isBlockedEitherWay(alice, bob, handle)).toBe(true);
    expect(await isBlockedEitherWay(bob, alice, handle)).toBe(true);
    expect(await isBlockedEitherWay(alice, carol, handle)).toBe(false);
    expect(await isBlockedEitherWay(bob, carol, handle)).toBe(false);
    expect(await isBlockedEitherWay(alice, alice, handle)).toBe(false);

    await deleteMemberBlock(alice, bob, handle);
    expect(await isBlockedEitherWay(bob, alice, handle)).toBe(false);
  });
});

describe('what the three reads leave out', () => {
  let alice: string;
  let bob: string;
  let carol: string;
  let where: string;
  let bobsNote: string;
  let alicesNote: string;
  let carolsNote: string;
  let alicesReplyUnderBob: string;
  let bobsReplyUnderAlice: string;
  let bobsReplyUnderCarol: string;
  let carolsReplyUnderAlice: string;

  beforeAll(async () => {
    [alice, bob, carol] = await Promise.all([newUser('Alice'), newUser('Bob'), newUser('Carol')]);
    where = await newRecording('Blocks');

    bobsNote = (await topLevel(where, bob, 1_000)).id;
    alicesNote = (await topLevel(where, alice, 2_000)).id;
    carolsNote = (await topLevel(where, carol, 3_000)).id;

    alicesReplyUnderBob = (await reply(where, alice, bobsNote)).id;
    bobsReplyUnderAlice = (await reply(where, bob, alicesNote)).id;
    bobsReplyUnderCarol = (await reply(where, bob, carolsNote)).id;
    carolsReplyUnderAlice = (await reply(where, carol, alicesNote)).id;

    // Everybody reacts to Carol's note; Bob and Carol react to Alice's.
    await setNoteReaction(carolsNote, alice, EMOJI, handle);
    await setNoteReaction(carolsNote, bob, EMOJI, handle);
    await setNoteReaction(carolsNote, carol, EMOJI, handle);
    await setNoteReaction(alicesNote, bob, EMOJI, handle);
    await setNoteReaction(alicesNote, carol, EMOJI, handle);

    await insertMemberBlock(alice, bob, handle);
  });

  it('leaves the blocked member’s note out of the blocker’s list, and the blocker’s out of the blocked member’s', async () => {
    const forAlice = (await listNotesForReader(where, alice, handle)).map((row) => row.id);
    expect(forAlice).toEqual([alicesNote, carolsNote]);

    const forBob = (await listNotesForReader(where, bob, handle)).map((row) => row.id);
    expect(forBob).toEqual([bobsNote, carolsNote]);

    const forCarol = (await listNotesForReader(where, carol, handle)).map((row) => row.id);
    expect(forCarol).toEqual([bobsNote, alicesNote, carolsNote]);
  });

  it('leaves the other side’s replies out of each thread, for both and only both', async () => {
    const parents = [bobsNote, alicesNote, carolsNote];
    // The read orders by parent then by time, and parents are random ids — so the *set* is the
    // claim here, and the within-thread order is notes.test.ts's.
    const sorted = (ids: readonly string[]) => [...ids].sort();

    const forAlice = (await listRepliesForNotes(parents, alice, handle)).map((row) => row.id);
    // Her own reply under Bob's note is still a row — it is the parent read that takes it away.
    expect(sorted(forAlice)).toEqual(sorted([alicesReplyUnderBob, carolsReplyUnderAlice]));

    const forBob = (await listRepliesForNotes(parents, bob, handle)).map((row) => row.id);
    expect(sorted(forBob)).toEqual(
      sorted([bobsReplyUnderAlice, carolsReplyUnderAlice, bobsReplyUnderCarol]),
    );

    const forCarol = (await listRepliesForNotes(parents, carol, handle)).map((row) => row.id);
    expect(sorted(forCarol)).toEqual(
      sorted([alicesReplyUnderBob, bobsReplyUnderAlice, carolsReplyUnderAlice, bobsReplyUnderCarol]),
    );
  });

  it('counts reactions from people the reader can see, and nobody else’s', async () => {
    const count = (rows: Awaited<ReturnType<typeof listReactionsForNotes>>, noteId: string) =>
      rows.find((row) => row.noteId === noteId)?.count ?? 0;

    const forAlice = await listReactionsForNotes([alicesNote, carolsNote], alice, handle);
    expect(count(forAlice, alicesNote)).toBe(1);
    expect(count(forAlice, carolsNote)).toBe(2);
    expect(forAlice.find((row) => row.noteId === carolsNote)?.mine).toBe(true);

    // Bob's own reaction on Alice's note is still his to count — a block never hides a member
    // from themselves — and Carol's beside it. Only Alice's reaction on Carol's note is gone.
    const forBob = await listReactionsForNotes([alicesNote, carolsNote], bob, handle);
    expect(count(forBob, alicesNote)).toBe(2);
    expect(forBob.find((row) => row.noteId === alicesNote)?.mine).toBe(true);
    expect(count(forBob, carolsNote)).toBe(2);

    const forCarol = await listReactionsForNotes([alicesNote, carolsNote], carol, handle);
    expect(count(forCarol, alicesNote)).toBe(2);
    expect(count(forCarol, carolsNote)).toBe(3);
  });

  it('lets a tombstone fall for the reader whose only live reply under it is blocked', async () => {
    const dave = await newUser('Dave');
    const here = await newRecording('Tombstones');
    const removed = (await topLevel(here, carol, 500)).id;
    await reply(here, bob, removed);
    await softDeleteNote(removed, carol, handle);

    // Held open for Dave and for Carol, whose thread it still is.
    expect((await listNotesForReader(here, dave, handle)).map((row) => row.id)).toEqual([removed]);
    expect((await listNotesForReader(here, carol, handle)).map((row) => row.id)).toEqual([removed]);
    // Not for Alice, who would be shown a tombstone over nothing.
    expect(await listNotesForReader(here, alice, handle)).toEqual([]);
  });

  it('shows everything again once the block is lifted', async () => {
    await deleteMemberBlock(alice, bob, handle);
    const forAlice = (await listNotesForReader(where, alice, handle)).map((row) => row.id);
    expect(forAlice).toEqual([bobsNote, alicesNote, carolsNote]);
    const count = (await listReactionsForNotes([alicesNote], alice, handle))[0]?.count;
    expect(count).toBe(2);
  });
});
