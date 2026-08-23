import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import { runMigrations } from '@thp/db';
import { MAX_NOTE_LENGTH, NOTE_VISIBILITIES } from '@thp/shared';
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

  recordingId = await newRecording('note-table');
  authorId = await newUser('note-author');
}, 180_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await target?.drop();
}, 60_000);

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
