import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  countEditedChapters,
  countEditedChaptersByRecording,
  createDatabase,
  deleteChapter,
  findChapterById,
  findTranscriptEndMs,
  insertChapter,
  insertRecording,
  listChapters,
  replaceChapters,
  replaceTranscript,
  runMigrations,
  updateChapter,
  type DatabaseHandle,
} from '@thp/db';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * **The chapter store** ([3.22](docs/project/prd.md), [4.19](docs/project/prd.md)), against a real
 * database.
 *
 * Real because the properties under test are properties of the *table* rather than of the functions
 * over it: that two chapters of one teaching cannot start at the same moment, that a replace leaves
 * one list however many times it runs, and that a teaching being deleted takes its chapters with
 * it. None of those is assertable against a fake, and each of them is what makes
 * [3.22.2](docs/project/prd.md)'s tiling unrepresentable-broken rather than merely validated.
 */

const databaseUrl = inject('databaseUrl');
const MINUTE = 60_000;

const GENERATED = { model: 'fake', modelVersion: 'fake-1', promptVersion: 'chapters-1' };

let target: ThrowawayDatabase;
let handle: DatabaseHandle;
let sql: postgres.Sql;
let made = 0;

/** A recording with a transcript behind it, so a chapter has something to divide. */
async function teaching(options: { transcript?: boolean } = {}): Promise<string> {
  made += 1;
  const row = await insertRecording(
    {
      originalMediaKey: `originals/chapters-${made}-${Date.now().toString(36)}.mp3`,
      title: `Teaching ${made}`,
      recordedAt: '2026-08-16',
    },
    handle,
  );

  if (options.transcript !== false) {
    await replaceTranscript(
      {
        recordingId: row.id,
        language: 'en',
        confidence: 0.95,
        segments: Array.from({ length: 6 }, (_unused, index) => ({
          startMs: index * 10 * MINUTE,
          endMs: (index + 1) * 10 * MINUTE,
          text: `Line ${index + 1}.`,
        })),
      },
      handle,
    );
  }

  return row.id;
}

const THREE = [
  { startMs: 0, title: 'The vine', summary: 'Abiding.' },
  { startMs: 20 * MINUTE, title: 'The branches', summary: 'Bearing fruit.' },
  { startMs: 40 * MINUTE, title: 'The gardener', summary: 'Pruning.' },
];

beforeAll(async () => {
  target = await createThrowawayDatabase(databaseUrl, 'chapters');
  await runMigrations({ url: target.url });
  sql = postgres(target.url, { max: 4, onnotice: () => {} });
  handle = createDatabase({ url: target.url, max: 6 });
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await sql?.end({ timeout: 5 });
  await target?.drop();
}, 60_000);

describe('writing a teaching’s chapters (3.22.9)', () => {
  it('writes the list and reads it back in start order', async () => {
    const recordingId = await teaching();
    // Out of order on the way in, so "in order" is the read's answer rather than the caller's.
    await replaceChapters(recordingId, [THREE[2]!, THREE[0]!, THREE[1]!], GENERATED, handle);

    const rows = await listChapters(recordingId, handle);
    expect(rows.map((one) => one.title)).toEqual(['The vine', 'The branches', 'The gardener']);
    expect(rows.map((one) => one.startMs)).toEqual([0, 20 * MINUTE, 40 * MINUTE]);
  });

  /**
   * Dispatch is at-least-once, so the write has to leave one list however many times the handler
   * runs ([3.21.2.6](docs/project/prd.md)) — and because a chapter has no `end_ms` to keep in step,
   * replacing cannot leave a gap behind.
   */
  it('leaves one list when it runs twice', async () => {
    const recordingId = await teaching();
    await replaceChapters(recordingId, THREE, GENERATED, handle);
    await replaceChapters(recordingId, THREE, GENERATED, handle);

    expect(await listChapters(recordingId, handle)).toHaveLength(3);
  });

  it('replaces rather than appends, so a second run is what the teaching now has', async () => {
    const recordingId = await teaching();
    await replaceChapters(recordingId, THREE, GENERATED, handle);
    await replaceChapters(
      recordingId,
      [
        { startMs: 0, title: 'One half', summary: 'The first.' },
        { startMs: 30 * MINUTE, title: 'The other', summary: 'The second.' },
      ],
      GENERATED,
      handle,
    );

    const rows = await listChapters(recordingId, handle);
    expect(rows.map((one) => one.title)).toEqual(['One half', 'The other']);
  });

  /** 3.22.4's "gets none", written as the absence of rows. */
  it('takes an empty list, which is a teaching too short to divide', async () => {
    const recordingId = await teaching();
    await replaceChapters(recordingId, THREE, GENERATED, handle);
    await replaceChapters(recordingId, [], GENERATED, handle);

    expect(await listChapters(recordingId, handle)).toEqual([]);
  });

  it('records which model and which prompt produced the list (4.19, 4.17.5)', async () => {
    const recordingId = await teaching();
    const [written] = await replaceChapters(recordingId, THREE, GENERATED, handle);

    expect(written?.generatedBy).toEqual(GENERATED);
    // Nothing this step writes has been touched by a person; the edit path is what sets it.
    expect(written?.editedByAdmin).toBe(false);
  });
});

describe('what the table refuses (3.22.2)', () => {
  /**
   * **One chapter may start at one moment.** This is what makes the derived order — and therefore
   * the derived position — total rather than arbitrary, and it is enforced at the database rather
   * than only by whichever caller happens to check.
   */
  it('refuses two chapters of one teaching starting at the same moment', async () => {
    const recordingId = await teaching();
    await replaceChapters(recordingId, THREE, GENERATED, handle);

    await expect(
      insertChapter(
        {
          recordingId,
          startMs: 20 * MINUTE,
          title: 'A second one here',
          summary: 'Which cannot be.',
          generatedBy: GENERATED,
        },
        handle,
      ),
    ).rejects.toThrow();
  });

  it('lets two different teachings start a chapter at the same moment', async () => {
    const first = await teaching();
    const second = await teaching();
    await replaceChapters(first, THREE, GENERATED, handle);
    await replaceChapters(second, THREE, GENERATED, handle);

    expect(await listChapters(first, handle)).toHaveLength(3);
    expect(await listChapters(second, handle)).toHaveLength(3);
  });

  it('refuses a start before the beginning of the teaching', async () => {
    const recordingId = await teaching();
    await expect(
      sql`insert into chapter (recording_id, start_ms, title, summary, generated_by)
          values (${recordingId}, -1, 'Before', 'The beginning.', '{}'::jsonb)`,
    ).rejects.toThrow();
  });

  /** Chapters of a teaching that is gone divide nothing. */
  it('takes its chapters with the teaching when the teaching goes', async () => {
    const recordingId = await teaching();
    await replaceChapters(recordingId, THREE, GENERATED, handle);

    await sql`delete from recording where id = ${recordingId}`;
    const left = await sql`select count(*)::int as left from chapter where recording_id = ${recordingId}`;
    expect((left[0] as { left: number }).left).toBe(0);
  });
});

describe('editing in place (3.22.7)', () => {
  it('retitles, rewrites and moves in one write, and records that a human did', async () => {
    const recordingId = await teaching();
    const rows = await replaceChapters(recordingId, THREE, GENERATED, handle);
    const second = rows[1]!;

    const edited = await updateChapter(
      {
        id: second.id,
        title: 'The branches, renamed',
        summary: 'Rewritten by an admin.',
        startMs: 30 * MINUTE,
      },
      handle,
    );

    expect(edited.title).toBe('The branches, renamed');
    expect(edited.startMs).toBe(30 * MINUTE);
    // 4.19, 4.17.5 — set by the statement rather than passed in, because this path only exists for
    // a human and nothing else may write it.
    expect(edited.editedByAdmin).toBe(true);
  });

  /**
   * **Moving a boundary is one write to one row** (project tdd 3.7). Because a chapter ends where
   * the next one begins, moving *this* chapter's start is what ends the one before it — so nothing
   * else in the list is touched, and the tiling cannot half-fail.
   */
  it('changes no other row when a boundary moves', async () => {
    const recordingId = await teaching();
    const rows = await replaceChapters(recordingId, THREE, GENERATED, handle);

    await updateChapter(
      { id: rows[1]!.id, title: rows[1]!.title, summary: rows[1]!.summary, startMs: 30 * MINUTE },
      handle,
    );

    const after = await listChapters(recordingId, handle);
    expect(after.map((one) => one.startMs)).toEqual([0, 30 * MINUTE, 40 * MINUTE]);
    expect(after[0]!.editedByAdmin).toBe(false);
    expect(after[2]!.editedByAdmin).toBe(false);
  });

  it('adds one row when a chapter is split, carrying the run that produced the list', async () => {
    const recordingId = await teaching();
    const rows = await replaceChapters(recordingId, THREE, GENERATED, handle);

    const added = await insertChapter(
      {
        recordingId,
        startMs: 10 * MINUTE,
        title: 'The second half of the first',
        summary: 'Cut out by an admin.',
        generatedBy: rows[0]!.generatedBy,
      },
      handle,
    );

    expect(added.editedByAdmin).toBe(true);
    expect(added.generatedBy).toEqual(GENERATED);
    expect((await listChapters(recordingId, handle)).map((one) => one.startMs)).toEqual([
      0,
      10 * MINUTE,
      20 * MINUTE,
      40 * MINUTE,
    ]);
  });

  it('removes one row when a chapter is merged, and writes to no other', async () => {
    const recordingId = await teaching();
    const rows = await replaceChapters(recordingId, THREE, GENERATED, handle);

    expect(await deleteChapter(rows[1]!.id, handle)).toBe(true);
    expect(await deleteChapter(rows[1]!.id, handle)).toBe(false);

    const after = await listChapters(recordingId, handle);
    expect(after.map((one) => one.title)).toEqual(['The vine', 'The gardener']);
    expect(after.every((one) => !one.editedByAdmin)).toBe(true);
  });

  it('finds one chapter by id, with its recording on the row', async () => {
    const recordingId = await teaching();
    const rows = await replaceChapters(recordingId, THREE, GENERATED, handle);

    expect((await findChapterById(rows[0]!.id, handle))?.recordingId).toBe(recordingId);
    expect(await findChapterById('00000000-0000-4000-8000-000000000000', handle)).toBeNull();
  });
});

describe('what a re-run would discard (3.22.8)', () => {
  it('counts the chapters a human has changed, per teaching and across the library', async () => {
    const untouched = await teaching();
    const edited = await teaching();
    await replaceChapters(untouched, THREE, GENERATED, handle);
    const rows = await replaceChapters(edited, THREE, GENERATED, handle);

    expect(await countEditedChapters(edited, handle)).toBe(0);

    await updateChapter(
      { id: rows[0]!.id, title: 'Renamed', summary: rows[0]!.summary, startMs: rows[0]!.startMs },
      handle,
    );
    await updateChapter(
      { id: rows[2]!.id, title: 'Renamed too', summary: rows[2]!.summary, startMs: rows[2]!.startMs },
      handle,
    );

    expect(await countEditedChapters(edited, handle)).toBe(2);
    expect(await countEditedChapters(untouched, handle)).toBe(0);

    const across = await countEditedChaptersByRecording(handle);
    expect(across.get(edited)).toBe(2);
    // Absent rather than present carrying a zero — the caller reads a missing key as none.
    expect(across.has(untouched)).toBe(false);
  });

  /** A replace is what a re-run does, and it clears the record of every edit with the rows. */
  it('forgets the edits when the list is replaced', async () => {
    const recordingId = await teaching();
    const rows = await replaceChapters(recordingId, THREE, GENERATED, handle);
    await updateChapter(
      { id: rows[0]!.id, title: 'Renamed', summary: rows[0]!.summary, startMs: rows[0]!.startMs },
      handle,
    );
    expect(await countEditedChapters(recordingId, handle)).toBe(1);

    await replaceChapters(recordingId, THREE, GENERATED, handle);
    expect(await countEditedChapters(recordingId, handle)).toBe(0);
  });
});

/**
 * **How long a teaching is, as far as the product knows** ([4.2](docs/project/prd.md)) — the end of
 * the last transcript segment, which is where the last chapter ends
 * ([4.19](docs/project/prd.md)).
 */
describe('the end of the last chapter (4.2, 4.19)', () => {
  it('is the end of the last transcript segment', async () => {
    const recordingId = await teaching();
    expect(await findTranscriptEndMs(recordingId, handle)).toBe(60 * MINUTE);
  });

  /** Nothing inspects an audio file on upload, so an untranscribed teaching has no length. */
  it('is nothing at all for a teaching nobody has transcribed', async () => {
    const recordingId = await teaching({ transcript: false });
    expect(await findTranscriptEndMs(recordingId, handle)).toBeNull();
  });
});

