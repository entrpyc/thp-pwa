import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  clearNoteReaction,
  createDatabase,
  insertNote,
  listNotesForReader,
  listReactionsForNotes,
  runMigrations,
  setNoteReaction,
  withTransaction,
  type DatabaseHandle,
} from '@thp/db';
import { MAX_NOTE_LENGTH, NOTE_VISIBILITIES, reactionName } from '@thp/shared';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * **The `note` table** (Task 1.1).
 *
 * Nothing here calls a store function, because there is not one yet: every statement below is raw
 * SQL against a database the migration runner built from empty. That is deliberate — the whole
 * claim of this task is that the rules hold **at the database**, and a test that went through a
 * store would be checking the store's memory instead.
 *
 * Each refusal is driven twice: the row the constraint is meant to refuse, and beside it the row it
 * is meant to accept. A `rejects.toThrow()` on its own passes just as well when the insert failed
 * for an unrelated reason, and "the shape it is supposed to allow still goes in" is what tells the
 * two apart.
 */

let target: ThrowawayDatabase;
let sql: ReturnType<typeof postgres>;
/** A store handle over the same throwaway database — the two new tables are read through one. */
let tableHandle: DatabaseHandle;

/** A recording and a member, so the two `NOT NULL` foreign keys have something to point at. */
let recordingId: string;
let authorId: string;

async function newRecording(key: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into recording (original_media_key, title, recorded_at)
    values (${`originals/${key}.mp3`}, ${`Teaching ${key}`}, '2026-05-01')
    returning id
  `;
  return row?.id as string;
}

async function newUser(label: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into "user" (email, password_hash, display_name, role)
    values (${`${label}@example.test`}, 'hash', ${label}, 'member')
    returning id
  `;
  return row?.id as string;
}

/** A top-level note, which is the only thing a reply can hang off. */
async function newTopLevel(
  options: {
    recording?: string;
    author?: string;
    visibility?: string;
    timestampMs?: number;
  } = {},
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into note (recording_id, author_id, visibility, timestamp_ms, text)
    values (
      ${options.recording ?? recordingId},
      ${options.author ?? authorId},
      ${options.visibility ?? 'public'},
      ${options.timestampMs ?? 90_000},
      'A thought at a moment.'
    )
    returning id
  `;
  return row?.id as string;
}

beforeAll(async () => {
  target = await createThrowawayDatabase(inject('databaseUrl'), 'note_table');
  await runMigrations({ url: target.url });
  sql = postgres(target.url, { max: 2, onnotice: () => {} });
  tableHandle = createDatabase({ url: target.url, max: 2 });

  recordingId = await newRecording('note-table');
  authorId = await newUser('note-author');
}, 180_000);

afterAll(async () => {
  await tableHandle?.close();
  await sql?.end({ timeout: 5 });
  await target?.drop();
}, 60_000);

/** How many reactions stand on this note, whatever anybody chose. */
async function reactionCount(noteId: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count from note_reaction where note_id = ${noteId}
  `;
  return Number(rows[0]?.count ?? '-1');
}

// =================================================================================================

describe('the migration creates the table the architecture describes', () => {
  it('carries exactly these columns', async () => {
    const rows = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'note'
      order by column_name
    `;
    expect(rows.map((row) => row.column_name)).toEqual([
      'author_id',
      'created_at',
      'deleted_at',
      'deleted_by',
      'edited_at',
      'id',
      'is_reply',
      'parent_id',
      'parent_is_reply',
      'recording_id',
      'text',
      'timestamp_ms',
      'visibility',
    ]);
  });

  it('has no column for anything this scope defers', async () => {
    const rows = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'note'
    `;
    const columns = new Set(rows.map((row) => row.column_name));

    // Each of these has a named home elsewhere, or is refused outright: reactions and pins are
    // their own tables, no revision history exists because an edit is permanent (3.5.1), no
    // moderation queue exists because moderation is on the note (3.6.3), and search is unbuilt.
    for (const deferred of [
      'reaction_count',
      'reactions',
      'pinned',
      'pinned_at',
      'pinned_by',
      'previous_text',
      'revision',
      'edit_count',
      'updated_at',
      'report_count',
      'flagged_at',
      'status',
      'search_vector',
      'embedding',
      'client_id',
      'position',
      'sort_order',
    ]) {
      expect(columns, `${deferred} is deferred and must not exist`).not.toContain(deferred);
    }
  });

  it('indexes the list order, the thread order and the pin key — read from the catalogue', async () => {
    const rows = await sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'note'
    `;
    const definitions = rows.map((row) => row.indexdef.toLowerCase());

    // Column order is the assertion, not merely presence: an index on the same three columns in a
    // different order does not answer "this recording's notes, in the list's order" with one scan.
    expect(
      definitions.some((definition) =>
        definition.includes('(recording_id, timestamp_ms, created_at)'),
      ),
    ).toBe(true);
    expect(definitions.some((definition) => definition.includes('(parent_id, created_at)'))).toBe(
      true,
    );
    expect(
      definitions.some(
        (definition) => definition.includes('unique') && definition.includes('(recording_id, id)'),
      ),
    ).toBe(true);
  });
});

describe('visibility is the shared tuple, and the database says so', () => {
  it('admits exactly the visibilities the shared constant declares, in its order', async () => {
    const rows = await sql<{ label: string }[]>`
      select enumlabel as label from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'note_visibility'
      order by enumsortorder
    `;
    expect(rows.map((row) => row.label)).toEqual([...NOTE_VISIBILITIES]);
  });

  it('refuses a visibility no composer could produce', async () => {
    await expect(newTopLevel({ visibility: 'group' })).rejects.toThrow();
  });
});

describe('what deleting a recording and deleting an author each do', () => {
  it('takes a teaching’s notes with the teaching', async () => {
    const doomed = await newRecording('note-cascade');
    const noteId = await newTopLevel({ recording: doomed });
    await sql`insert into note (recording_id, author_id, visibility, parent_id, text)
              values (${doomed}, ${authorId}, 'public', ${noteId}, 'And a reply.')`;

    await sql`delete from recording where id = ${doomed}`;

    const left = await sql<{ count: string }[]>`
      select count(*)::text as count from note where recording_id = ${doomed}
    `;
    expect(left[0]?.count).toBe('0');
  });

  it('refuses to delete an account that has written one, and keeps the note', async () => {
    const writer = await newUser('note-writer');
    const noteId = await newTopLevel({ author: writer });

    // Restrict, not cascade, and on purpose: re-attribution is unbuilt, so account deletion is
    // *meant* to fail here rather than quietly take a group's study notes with one account.
    await expect(sql`delete from "user" where id = ${writer}`).rejects.toThrow();

    const left = await sql<{ id: string }[]>`select id from note where id = ${noteId}`;
    expect(left).toHaveLength(1);
  });

  it('lets an account with no notes go, so the refusal is about the note and not the table', async () => {
    const bystander = await newUser('note-bystander');
    await expect(sql`delete from "user" where id = ${bystander}`).resolves.toBeTruthy();
  });
});

describe('a note has a position exactly when it is top-level', () => {
  it('accepts a top-level note with a position and a reply without one', async () => {
    const parent = await newTopLevel();
    await expect(
      sql`insert into note (recording_id, author_id, visibility, parent_id, text)
          values (${recordingId}, ${authorId}, 'public', ${parent}, 'A reply.')`,
    ).resolves.toBeTruthy();
  });

  it('refuses a top-level note with no position', async () => {
    await expect(
      sql`insert into note (recording_id, author_id, visibility, text)
          values (${recordingId}, ${authorId}, 'public', 'Nowhere in particular.')`,
    ).rejects.toThrow();
  });

  it('refuses a reply that carries one', async () => {
    const parent = await newTopLevel();
    await expect(
      sql`insert into note (recording_id, author_id, visibility, parent_id, timestamp_ms, text)
          values (${recordingId}, ${authorId}, 'public', ${parent}, 120000, 'A reply at a moment.')`,
    ).rejects.toThrow();
  });
});

describe('one level of reply, refused by the database rather than by a lookup', () => {
  it('refuses a reply whose parent is itself a reply', async () => {
    const parent = await newTopLevel();
    const [reply] = await sql<{ id: string }[]>`
      insert into note (recording_id, author_id, visibility, parent_id, text)
      values (${recordingId}, ${authorId}, 'public', ${parent}, 'A reply.')
      returning id
    `;
    const replyId = reply?.id as string;

    await expect(
      sql`insert into note (recording_id, author_id, visibility, parent_id, text)
          values (${recordingId}, ${authorId}, 'public', ${replyId}, 'A reply to a reply.')`,
    ).rejects.toThrow();
  });

  it('refuses a parent that does not exist at all', async () => {
    await expect(
      sql`insert into note (recording_id, author_id, visibility, parent_id, text)
          values (${recordingId}, ${authorId}, 'public',
                  '00000000-0000-0000-0000-000000000000', 'Hanging off nothing.')`,
    ).rejects.toThrow();
  });

  it('refuses to delete a note that has a reply under it', async () => {
    const parent = await newTopLevel();
    await sql`insert into note (recording_id, author_id, visibility, parent_id, text)
              values (${recordingId}, ${authorId}, 'public', ${parent}, 'A reply.')`;

    await expect(sql`delete from note where id = ${parent}`).rejects.toThrow();
  });
});

describe('the rules a note can never break', () => {
  it('refuses a private reply and accepts a public one', async () => {
    const parent = await newTopLevel();
    await expect(
      sql`insert into note (recording_id, author_id, visibility, parent_id, text)
          values (${recordingId}, ${authorId}, 'private', ${parent}, 'Quietly.')`,
    ).rejects.toThrow();
    await expect(
      sql`insert into note (recording_id, author_id, visibility, parent_id, text)
          values (${recordingId}, ${authorId}, 'public', ${parent}, 'Out loud.')`,
    ).resolves.toBeTruthy();
  });

  it('leaves a private top-level note alone — the rule is about replies', async () => {
    await expect(newTopLevel({ visibility: 'private' })).resolves.toBeTruthy();
  });

  it('accepts a note of exactly the ceiling and refuses one character more', async () => {
    const atCeiling = 'x'.repeat(MAX_NOTE_LENGTH);
    await expect(
      sql`insert into note (recording_id, author_id, visibility, timestamp_ms, text)
          values (${recordingId}, ${authorId}, 'public', 1000, ${atCeiling})`,
    ).resolves.toBeTruthy();

    await expect(
      sql`insert into note (recording_id, author_id, visibility, timestamp_ms, text)
          values (${recordingId}, ${authorId}, 'public', 1000, ${`${atCeiling}x`})`,
    ).rejects.toThrow();
  });

  it('counts characters rather than bytes, so a note in any script gets the same room', async () => {
    // Every one of these is two bytes in UTF-8; a byte-length ceiling would refuse the row.
    const cyrillic = 'ж'.repeat(MAX_NOTE_LENGTH);
    await expect(
      sql`insert into note (recording_id, author_id, visibility, timestamp_ms, text)
          values (${recordingId}, ${authorId}, 'public', 1000, ${cyrillic})`,
    ).resolves.toBeTruthy();
  });

  it('refuses a row carrying both a deletion and text', async () => {
    const noteId = await newTopLevel();
    await expect(sql`update note set deleted_at = now() where id = ${noteId}`).rejects.toThrow();
  });

  it('refuses a row carrying neither', async () => {
    await expect(
      sql`insert into note (recording_id, author_id, visibility, timestamp_ms, text)
          values (${recordingId}, ${authorId}, 'public', 1000, null)`,
    ).rejects.toThrow();
  });

  it('accepts a tombstone — the deletion and the text going together', async () => {
    const noteId = await newTopLevel();
    await expect(
      sql`update note set text = null, deleted_at = now(), deleted_by = ${authorId}
          where id = ${noteId}`,
    ).resolves.toBeTruthy();

    const rows = await sql<{ text: string | null; deleted_by: string | null }[]>`
      select text, deleted_by from note where id = ${noteId}
    `;
    expect(rows[0]?.text).toBeNull();
    expect(rows[0]?.deleted_by).toBe(authorId);
  });

  it('keeps the tombstone when the account that deleted it is removed', async () => {
    const moderator = await newUser('note-moderator');
    const noteId = await newTopLevel();
    await sql`update note set text = null, deleted_at = now(), deleted_by = ${moderator}
              where id = ${noteId}`;

    await sql`delete from "user" where id = ${moderator}`;

    const rows = await sql<{ deleted_at: Date | null; deleted_by: string | null }[]>`
      select deleted_at, deleted_by from note where id = ${noteId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deleted_by).toBeNull();
    expect(rows[0]?.deleted_at).not.toBeNull();
  });
});

// =================================================================================================

/**
 * **The notes store** (Task 1.2) — the module that owns every statement against `note` and, with
 * it, the private-note condition.
 *
 * Its own database and its own connections: the suite above drives raw SQL at a table and this one
 * drives the store, and sharing a database would let a store bug hide behind a row the other suite
 * happened to leave behind.
 *
 * Every read below is asked by **two different readers** wherever privacy is the point. A read that
 * returns the right rows to their author proves nothing on its own — the failure this module exists
 * to prevent is a note reaching somebody else, so the second reader is the assertion.
 */
describe('the notes store', () => {
  let store: ThrowawayDatabase;
  let storeSql: ReturnType<typeof postgres>;
  let handle: DatabaseHandle;

  /** Two members and a teaching. Alice writes; Bella is who must not see the private ones. */
  let alice: string;
  let bella: string;

  async function member(label: string): Promise<string> {
    const [row] = await storeSql<{ id: string }[]>`
      insert into "user" (email, password_hash, display_name, role)
      values (${`${label}@example.test`}, 'hash', ${label}, 'member')
      returning id
    `;
    return row?.id as string;
  }

  async function recording(key: string): Promise<string> {
    const [row] = await storeSql<{ id: string }[]>`
      insert into recording (original_media_key, title, recorded_at)
      values (${`originals/${key}.mp3`}, ${`Teaching ${key}`}, '2026-06-01')
      returning id
    `;
    return row?.id as string;
  }

  beforeAll(async () => {
    store = await createThrowawayDatabase(inject('databaseUrl'), 'notes_store');
    await runMigrations({ url: store.url });
    storeSql = postgres(store.url, { max: 2, onnotice: () => {} });
    handle = createDatabase({ url: store.url, max: 4 });

    alice = await member('alice');
    bella = await member('bella');
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await storeSql?.end({ timeout: 5 });
    await store?.drop();
  }, 60_000);

  // ---------------------------------------------------------------------------------------------
  // 1.2.1 — the write

  describe('writing a note', () => {
    it('returns the row it wrote, with the values it was given', async () => {
      const where = await recording('write-returns');
      const row = await insertNote(
        {
          recordingId: where,
          authorId: alice,
          visibility: 'private',
          text: 'The bit about stillness.',
          timestampMs: 92_000,
        },
        handle,
      );

      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.recordingId).toBe(where);
      expect(row.authorId).toBe(alice);
      expect(row.visibility).toBe('private');
      expect(row.text).toBe('The bit about stillness.');
      expect(row.timestampMs).toBe(92_000);
      expect(row.parentId).toBeNull();
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.editedAt).toBeNull();
      expect(row.deletedAt).toBeNull();
      expect(row.deletedBy).toBeNull();
    });

    it('actually writes it — the row is there when another connection looks', async () => {
      const where = await recording('write-persists');
      const row = await insertNote(
        {
          recordingId: where,
          authorId: alice,
          visibility: 'public',
          text: 'Written.',
          timestampMs: 10,
        },
        handle,
      );

      // Read back over a different connection than the one that wrote it: a store that returned a
      // plausible object without committing would pass every assertion above and fail this one.
      const rows = await storeSql<{ text: string; timestamp_ms: number }[]>`
        select text, timestamp_ms from note where id = ${row.id}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.text).toBe('Written.');
      expect(rows[0]?.timestamp_ms).toBe(10);
    });

    it('takes an executor, so a caller can roll the write back with the rest of its work', async () => {
      const where = await recording('write-in-transaction');
      let written = '';

      await expect(
        withTransaction(async (tx) => {
          const row = await insertNote(
            {
              recordingId: where,
              authorId: alice,
              visibility: 'public',
              text: 'Doomed.',
              timestampMs: 1,
            },
            tx,
          );
          written = row.id;
          throw new Error('the caller changed its mind');
        }, handle),
      ).rejects.toThrow('the caller changed its mind');

      // The whole point of the executor: the note went back with the transaction. A store that
      // opened its own connection would leave this row behind.
      expect(written).not.toBe('');
      expect(await storeSql`select id from note where id = ${written}`).toHaveLength(0);
    });

    it('does not return the table plumbing — a caller sees a note, not its generated columns', async () => {
      const where = await recording('write-columns');
      const row = await insertNote(
        {
          recordingId: where,
          authorId: alice,
          visibility: 'public',
          text: 'Named.',
          timestampMs: 5,
        },
        handle,
      );

      // `is_reply` and `parent_is_reply` are how the one-level rule is enforced (§ 6.1). A
      // `select *` would carry them out of the package to every caller downstream.
      expect(Object.keys(row).sort()).toEqual([
        'authorId',
        'createdAt',
        'deletedAt',
        'deletedBy',
        'editedAt',
        'id',
        'parentId',
        'recordingId',
        'text',
        'timestampMs',
        'visibility',
      ]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 1.2.2 — the order

  describe('the order a teaching reads in', () => {
    it('is by position, then by when it was written, and is the same on every call', async () => {
      const where = await recording('order');

      // Written deliberately out of order, so a store that returned insertion order would look
      // right for the wrong reason.
      const late = await insertNote(
        {
          recordingId: where,
          authorId: alice,
          visibility: 'public',
          text: 'late',
          timestampMs: 300_000,
        },
        handle,
      );
      const firstAtSame = await insertNote(
        {
          recordingId: where,
          authorId: alice,
          visibility: 'public',
          text: 'same-a',
          timestampMs: 60_000,
        },
        handle,
      );
      const early = await insertNote(
        { recordingId: where, authorId: alice, visibility: 'public', text: 'early', timestampMs: 0 },
        handle,
      );
      const secondAtSame = await insertNote(
        {
          recordingId: where,
          authorId: alice,
          visibility: 'public',
          text: 'same-b',
          timestampMs: 60_000,
        },
        handle,
      );

      const once = await listNotesForReader(where, alice, handle);
      expect(once.map((row) => row.id)).toEqual([
        early.id,
        firstAtSame.id,
        secondAtSame.id,
        late.id,
      ]);

      const twice = await listNotesForReader(where, alice, handle);
      expect(twice.map((row) => row.id)).toEqual(once.map((row) => row.id));
    });

    it('breaks a tie by when the note was written, not by where the row happens to sit', async () => {
      const where = await recording('order-tie');

      // Three notes at the same moment, written in an order that is **not** their `created_at`
      // order — planted with raw SQL, because that is the only way to make the two disagree.
      //
      // Without the tie-break stated, the sort has nothing to separate these three and returns them
      // in the order the rows come off the heap, which is the order below. With it, they come back
      // b → c → a. The test is the difference between those two orders, so an `order by
      // timestamp_ms` on its own cannot pass it.
      const planted = await storeSql<{ id: string; text: string }[]>`
        insert into note (recording_id, author_id, visibility, timestamp_ms, text, created_at)
        values
          (${where}, ${alice}, 'public', 60000, 'written third',  '2026-06-01T12:00:03Z'),
          (${where}, ${alice}, 'public', 60000, 'written first',  '2026-06-01T12:00:01Z'),
          (${where}, ${alice}, 'public', 60000, 'written second', '2026-06-01T12:00:02Z')
        returning id, text
      `;
      expect(planted.map((row) => row.text)).toEqual([
        'written third',
        'written first',
        'written second',
      ]);

      const rows = await listNotesForReader(where, alice, handle);
      expect(rows.map((row) => row.text)).toEqual([
        'written first',
        'written second',
        'written third',
      ]);

      // And the same answer twice, which is what a member reloading the tab is promised.
      const again = await listNotesForReader(where, alice, handle);
      expect(again.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    });

    it('reads only the teaching it was asked about', async () => {
      const here = await recording('scoped-here');
      const elsewhere = await recording('scoped-elsewhere');
      const mine = await insertNote(
        { recordingId: here, authorId: alice, visibility: 'public', text: 'here', timestampMs: 1 },
        handle,
      );
      await insertNote(
        {
          recordingId: elsewhere,
          authorId: alice,
          visibility: 'public',
          text: 'there',
          timestampMs: 1,
        },
        handle,
      );

      expect((await listNotesForReader(here, alice, handle)).map((row) => row.id)).toEqual([
        mine.id,
      ]);
    });

    it('leaves replies out — a note with no position has no place in a list ordered by one', async () => {
      const where = await recording('order-replies');
      const parent = await insertNote(
        {
          recordingId: where,
          authorId: alice,
          visibility: 'public',
          text: 'the note',
          timestampMs: 4_000,
        },
        handle,
      );
      await insertNote(
        {
          recordingId: where,
          authorId: alice,
          visibility: 'public',
          text: 'the reply',
          parentId: parent.id,
        },
        handle,
      );

      const rows = await listNotesForReader(where, alice, handle);
      expect(rows.map((row) => row.text)).toEqual(['the note']);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 1.2.3 — the private-note condition

  describe('what a reader may see', () => {
    it('returns every public note plus the reader own private ones, and nobody else private ones', async () => {
      const where = await recording('privacy');
      const alicePublic = await insertNote(
        {
          recordingId: where,
          authorId: alice,
          visibility: 'public',
          text: 'alice public',
          timestampMs: 1_000,
        },
        handle,
      );
      const alicePrivate = await insertNote(
        {
          recordingId: where,
          authorId: alice,
          visibility: 'private',
          text: 'alice private',
          timestampMs: 2_000,
        },
        handle,
      );
      const bellaPublic = await insertNote(
        {
          recordingId: where,
          authorId: bella,
          visibility: 'public',
          text: 'bella public',
          timestampMs: 3_000,
        },
        handle,
      );
      const bellaPrivate = await insertNote(
        {
          recordingId: where,
          authorId: bella,
          visibility: 'private',
          text: 'bella private',
          timestampMs: 4_000,
        },
        handle,
      );

      const forAlice = await listNotesForReader(where, alice, handle);
      expect(forAlice.map((row) => row.id)).toEqual([
        alicePublic.id,
        alicePrivate.id,
        bellaPublic.id,
      ]);

      const forBella = await listNotesForReader(where, bella, handle);
      expect(forBella.map((row) => row.id)).toEqual([
        alicePublic.id,
        bellaPublic.id,
        bellaPrivate.id,
      ]);

      // Stated as an absence too: the other member's private note is not in the payload at all, in
      // any position — which is the requirement, rather than "is not rendered".
      expect(forAlice.map((row) => row.text)).not.toContain('bella private');
      expect(forBella.map((row) => row.text)).not.toContain('alice private');
      expect(forAlice.some((row) => row.id === bellaPrivate.id)).toBe(false);
      expect(forBella.some((row) => row.id === alicePrivate.id)).toBe(false);
    });

    it('is a row rule, not a first-row rule — a private note in the middle is dropped too', async () => {
      const where = await recording('privacy-middle');
      const before = await insertNote(
        { recordingId: where, authorId: alice, visibility: 'public', text: 'before', timestampMs: 1_000 },
        handle,
      );
      await insertNote(
        { recordingId: where, authorId: bella, visibility: 'private', text: 'hidden', timestampMs: 2_000 },
        handle,
      );
      const after = await insertNote(
        { recordingId: where, authorId: alice, visibility: 'public', text: 'after', timestampMs: 3_000 },
        handle,
      );

      expect((await listNotesForReader(where, alice, handle)).map((row) => row.id)).toEqual([
        before.id,
        after.id,
      ]);
    });

    it('does not bend for a reader who has written nothing — an empty list, not everything', async () => {
      const where = await recording('privacy-stranger');
      await insertNote(
        { recordingId: where, authorId: alice, visibility: 'private', text: 'only mine', timestampMs: 1 },
        handle,
      );

      expect(await listNotesForReader(where, bella, handle)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 1.2.4 — what this module does not decide

  describe('publication is not this module to decide', () => {
    it('reads a note on an unpublished teaching — the gate is asked before this is called', async () => {
      const where = await recording('unpublished');
      const row = await insertNote(
        { recordingId: where, authorId: alice, visibility: 'public', text: 'on a draft', timestampMs: 1 },
        handle,
      );

      // `recording.published_at` is null on every row this suite makes, and the store returns the
      // note anyway. The publication gate is `visibility.ts`'s and the service asks it before this
      // module is reached — a store that compared the timestamp here would be the second copy
      // tests/guards/visibility-boundary.test.ts refuses.
      const [state] = await storeSql<{ published_at: Date | null }[]>`
        select published_at from recording where id = ${where}
      `;
      expect(state?.published_at).toBeNull();
      expect((await listNotesForReader(where, alice, handle)).map((one) => one.id)).toEqual([
        row.id,
      ]);
    });
  });
});

// =================================================================================================
// Task 4.1 — the `note_reaction` table
// =================================================================================================

/**
 * **How the group responded to a moment**, and the two properties that are the table's rather than
 * a service's: one reaction per member is a primary key, and a glyph that has left the vocabulary
 * is still a glyph that counts.
 */
describe('the note_reaction table', () => {
  it('carries exactly these columns, keyed by the note and the member together', async () => {
    const columns = await sql<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'note_reaction'
      order by column_name
    `;
    expect(columns.map((row) => row.column_name)).toEqual([
      'emoji',
      'note_id',
      'reacted_at',
      'user_id',
    ]);

    // `text`, and neither an enum nor a foreign key — which is exactly what makes 3.4.2 true.
    expect(columns.find((row) => row.column_name === 'emoji')?.data_type).toBe('text');

    const key = await sql<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = 'note_reaction'::regclass and contype = 'p'
    `;
    expect(key[0]?.definition.toLowerCase().replace(/\s+/g, ' ')).toBe(
      'primary key (note_id, user_id)',
    );
  });

  it('does not point emoji at a vocabulary table or an enum, in any form', async () => {
    // The absence is the requirement (3.4.2): both an enum and a foreign key would make removing a
    // value rewrite what a member already chose, which is the one thing that must not happen.
    const referenced = await sql<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = 'note_reaction'::regclass and contype = 'f'
    `;
    const targets = referenced.map((row) => row.definition.toLowerCase());
    expect(targets.some((one) => one.includes('(emoji)'))).toBe(false);

    const enums = await sql<{ typname: string }[]>`
      select t.typname from pg_type t
      join pg_enum e on e.enumtypid = t.oid
      where t.typname like '%reaction%'
      group by t.typname
    `;
    expect(enums).toEqual([]);
  });

  it('cascades from both halves, because a reaction without either is meaningless', async () => {
    const goingAway = await newRecording('reaction-cascade');
    const noteId = await newTopLevel({ recording: goingAway });
    const reactor = await newUser('reaction-cascade-member');
    await setNoteReaction(noteId, reactor, '🙏', tableHandle);

    // The member's side.
    await sql`delete from "user" where id = ${reactor}`;
    expect(await reactionCount(noteId)).toBe(0);

    // And the note's side, driven from a second row so the first deletion cannot pass for it.
    const second = await newUser('reaction-cascade-second');
    await setNoteReaction(noteId, second, '🔥', tableHandle);
    expect(await reactionCount(noteId)).toBe(1);
    await sql`delete from recording where id = ${goingAway}`;
    expect(await reactionCount(noteId)).toBe(0);
  });

  it('replaces a member’s reaction rather than adding a second row', async () => {
    const noteId = await newTopLevel();
    const member = await newUser('reaction-replacer');

    await setNoteReaction(noteId, member, '🙏', tableHandle);
    await setNoteReaction(noteId, member, '🔥', tableHandle);

    const rows = await sql<{ emoji: string }[]>`
      select emoji from note_reaction where note_id = ${noteId} and user_id = ${member}
    `;
    // One row, and it is the *second* choice — a delete-then-insert would also leave one row, so
    // the emoji is what tells "replaced" from "the first one survived".
    expect(rows.map((row) => row.emoji)).toEqual(['🔥']);
  });

  it('holds two members’ reactions on one note apart', async () => {
    const noteId = await newTopLevel();
    const [first, second] = await Promise.all([
      newUser('reaction-pair-one'),
      newUser('reaction-pair-two'),
    ]);

    await Promise.all([
      setNoteReaction(noteId, first, '🙏', tableHandle),
      setNoteReaction(noteId, second, '🙏', tableHandle),
    ]);

    const rows = await listReactionsForNotes([noteId], first, tableHandle);
    expect(rows).toEqual([{ noteId, emoji: '🙏', count: 2, mine: true }]);
  });

  it('still returns and still counts a glyph the vocabulary does not offer', async () => {
    const noteId = await newTopLevel();
    const [one, two] = await Promise.all([
      newUser('reaction-departed-one'),
      newUser('reaction-departed-two'),
    ]);
    // A glyph that is not in REACTIONS — the state the table is in after a product decision that
    // removes one. Nothing rewrites it and nothing drops it.
    const departed = '🕊';
    await setNoteReaction(noteId, one, departed, tableHandle);
    await setNoteReaction(noteId, two, departed, tableHandle);

    const rows = await listReactionsForNotes([noteId], one, tableHandle);
    expect(rows).toEqual([{ noteId, emoji: departed, count: 2, mine: true }]);
    // And it is labelled by itself rather than announced as nothing (packages/shared/reactions.ts).
    expect(reactionName(departed)).toBe(departed);
  });

  it('clears one member’s reaction and leaves everybody else’s', async () => {
    const noteId = await newTopLevel();
    const [leaving, staying] = await Promise.all([
      newUser('reaction-clear-one'),
      newUser('reaction-clear-two'),
    ]);
    await setNoteReaction(noteId, leaving, '🙏', tableHandle);
    await setNoteReaction(noteId, staying, '🙏', tableHandle);

    await clearNoteReaction(noteId, leaving, tableHandle);

    expect(await listReactionsForNotes([noteId], staying, tableHandle)).toEqual([
      { noteId, emoji: '🙏', count: 1, mine: true },
    ]);
  });
});

// =================================================================================================
// Task 6.2 — the `note_pin` table
// =================================================================================================

describe('the note_pin table', () => {
  it('carries exactly these columns, keyed by the note alone', async () => {
    const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'note_pin'
      order by column_name
    `;
    expect(columns.map((row) => row.column_name)).toEqual([
      'note_id',
      'pinned_at',
      'pinned_by',
      'recording_id',
    ]);

    // The key *is* "pinned at most once" (3.6.10) — said by the key rather than by a check.
    const key = await sql<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = 'note_pin'::regclass and contype = 'p'
    `;
    expect(key[0]?.definition.toLowerCase().replace(/\s+/g, ' ')).toBe('primary key (note_id)');
  });

  it('points at the note by recording and id together, cascading', async () => {
    const keys = await sql<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = 'note_pin'::regclass and contype = 'f'
    `;
    const toNote = keys
      .map((row) => row.definition.toLowerCase().replace(/\s+/g, ' '))
      .find((one) => one.includes('references note'));

    // The composite key is what stops a pin pointing at a note on a different recording *and*
    // stops the denormalised `recording_id` drifting from the note's own.
    expect(toNote).toContain('foreign key (recording_id, note_id)');
    expect(toNote).toContain('references note(recording_id, id)');
    expect(toNote).toContain('on delete cascade');

    // And `pinned_by` sets null, the house shape: the pin survives the account that made it.
    const toUser = keys
      .map((row) => row.definition.toLowerCase().replace(/\s+/g, ' '))
      .find((one) => one.includes('references "user"'));
    expect(toUser).toContain('on delete set null');
  });

  it('indexes the read it always does — the pins on one recording', async () => {
    const rows = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where schemaname = 'public' and tablename = 'note_pin'
    `;
    const definitions = rows.map((row) => row.indexdef.toLowerCase().replace(/\s+/g, ' '));
    expect(definitions.some((one) => one.includes('(recording_id)'))).toBe(true);
  });

  it('refuses a pin whose recording is not the note’s own', async () => {
    const elsewhere = await newRecording('pin-elsewhere');
    const noteId = await newTopLevel();

    // No matching `(recording_id, id)` pair exists, so the composite key has nothing to point at.
    await expect(
      sql`insert into note_pin (note_id, recording_id) values (${noteId}, ${elsewhere})`,
    ).rejects.toThrow();

    // And the honest pairing goes in, so the refusal is about the mismatch and not the table.
    await expect(
      sql`insert into note_pin (note_id, recording_id) values (${noteId}, ${recordingId})`,
    ).resolves.toBeTruthy();
    await sql`delete from note_pin where note_id = ${noteId}`;
  });
});
