import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  createDatabase,
  deleteEmbeddingsForSources,
  deleteMemberBlock,
  findEmbeddingsForSources,
  insertMemberBlock,
  insertNote,
  insertRecording,
  insertUser,
  isEmbeddingVisibleTo,
  listEmbeddingsForRecording,
  listVisibleEmbeddings,
  publishSummary,
  replaceTranscript,
  runMigrations,
  setRecordingPublication,
  setSummaryPublication,
  upsertEmbeddings,
  type DatabaseHandle,
  type EmbeddingVisibilityFacts,
  type NewEmbedding,
} from '@thp/db';
import { EMBEDDING_DIMENSIONS, type EmbeddingSourceKind } from '@thp/shared';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * **The embedding table, and the visibility rule over it, against a real database.**
 *
 * Two claims, neither of which a unit test could make:
 *
 * 1. **Embedding a source again replaces its row** — the `(source_kind, source_id)` uniqueness is
 *    a property of the table, and an upsert that appended would leave a corrected line's old
 *    words findable beside its new ones ([3.5.5](docs/project/prd.md)).
 * 2. **The SQL spelling of [3.10.9](docs/project/prd.md) says what the pure one says.** The rule
 *    is written twice in `visibility.ts` — once over facts, once as a `where` — and the unit test
 *    covers the first. This suite seeds every case the unit test enumerates (a draft summary,
 *    another member's private note, an unpublished recording) and holds the query to the function,
 *    row by row.
 */

const DIMENSION_FILL = Array.from({ length: EMBEDDING_DIMENSIONS }, (_unused, index) => index / 10_000);

function vectorOf(seed: number): number[] {
  return DIMENSION_FILL.map((value) => value + seed);
}

let target: ThrowawayDatabase;
let sql: postgres.Sql;
let handle: DatabaseHandle;
let made = 0;

async function recording(published: boolean): Promise<string> {
  made += 1;
  const row = await insertRecording(
    {
      originalMediaKey: `originals/embeddings-${made}-${Date.now().toString(36)}.mp3`,
      title: `Teaching ${made}`,
      recordedAt: '2026-10-01',
    },
    handle,
  );
  if (published) await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

async function member(label: string): Promise<string> {
  made += 1;
  const row = await insertUser(
    {
      email: `${label}-${made}@example.test`,
      passwordHash: 'hash',
      displayName: label,
      role: 'member',
    },
    handle,
  );
  return row.id;
}

function row(
  sourceKind: EmbeddingSourceKind,
  sourceId: string,
  recordingId: string | null,
  text: string,
  extras: Partial<NewEmbedding> = {},
): NewEmbedding {
  return {
    sourceKind,
    sourceId,
    recordingId,
    ownerUserId: null,
    text,
    vector: vectorOf(made),
    model: 'test-model',
    ...extras,
  };
}

beforeAll(async () => {
  target = await createThrowawayDatabase(inject('databaseUrl'), 'embeddings');
  await runMigrations({ url: target.url });
  sql = postgres(target.url, { max: 2, onnotice: () => {} });
  handle = createDatabase({ url: target.url, max: 4 });
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await sql?.end({ timeout: 5 });
  await target?.drop();
}, 60_000);

describe('embedding a source again replaces its row', () => {
  it('writes one row per source and overwrites it on the second write, keeping created_at', async () => {
    const recordingId = await recording(true);
    const transcript = await replaceTranscript(
      {
        recordingId,
        language: 'en',
        confidence: 0.9,
        segments: [{ startMs: 0, endMs: 1000, text: 'The first words.' }],
      },
      handle,
    );
    const [segment] = await sql<{ id: string }[]>`
      select id from segment where transcript_id = ${transcript.id}
    `;
    const segmentId = segment?.id as string;

    await upsertEmbeddings([row('segment', segmentId, recordingId, 'The first words.')], handle);
    const [first] = await findEmbeddingsForSources('segment', [segmentId], handle);
    expect(first?.text).toBe('The first words.');

    await new Promise((done) => setTimeout(done, 5));
    await upsertEmbeddings(
      [row('segment', segmentId, recordingId, 'The corrected words.', { model: 'test-model-2' })],
      handle,
    );

    const after = await findEmbeddingsForSources('segment', [segmentId], handle);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(first?.id);
    expect(after[0]?.text).toBe('The corrected words.');
    expect(after[0]?.model).toBe('test-model-2');
    expect(after[0]?.createdAt).toEqual(first?.createdAt);
    expect(after[0]?.updatedAt.getTime()).toBeGreaterThan(first?.updatedAt.getTime() ?? 0);

    // And the vector itself moved: the column holds the second write, not the first.
    const [stored] = await sql<{ embedding: string }[]>`
      select embedding::text as embedding from embedding where source_id = ${segmentId}
    `;
    expect(stored?.embedding.startsWith(`[${vectorOf(made)[0]}`)).toBe(true);
  });

  it('removes exactly the sources it is asked to and answers how many went', async () => {
    const recordingId = await recording(true);
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await upsertEmbeddings(
      [row('chapter', a, recordingId, 'A'), row('chapter', b, recordingId, 'B')],
      handle,
    );

    expect(await deleteEmbeddingsForSources('chapter', [a], handle)).toBe(1);
    expect((await listEmbeddingsForRecording(recordingId, handle)).map((one) => one.sourceId)).toEqual([b]);
    expect(await deleteEmbeddingsForSources('chapter', [a], handle)).toBe(0);
  });

  it('goes with its recording', async () => {
    const recordingId = await recording(true);
    await upsertEmbeddings([row('chapter', crypto.randomUUID(), recordingId, 'A')], handle);
    await sql`delete from recording where id = ${recordingId}`;
    expect(await listEmbeddingsForRecording(recordingId, handle)).toEqual([]);
  });

  /** What Postgres said, under the query drizzle wraps it in. */
  async function refusal(write: Promise<unknown>): Promise<string> {
    return write.then(
      () => 'nothing was refused',
      (error: unknown) => {
        const cause = (error as { cause?: unknown }).cause;
        return cause instanceof Error ? cause.message : String(error);
      },
    );
  }

  it('refuses a vector of the wrong width at the column', async () => {
    const recordingId = await recording(true);
    expect(
      await refusal(
        upsertEmbeddings(
          [{ ...row('chapter', crypto.randomUUID(), recordingId, 'A'), vector: [1, 2, 3] }],
          handle,
        ),
      ),
    ).toMatch(/dimensions/);
  });

  it('refuses an owner on anything but a note, and a recording-less row on anything but a series', async () => {
    const recordingId = await recording(true);
    const owner = await member('owner');
    expect(
      await refusal(
        upsertEmbeddings(
          [row('segment', crypto.randomUUID(), recordingId, 'A', { ownerUserId: owner })],
          handle,
        ),
      ),
    ).toMatch(/embedding_owner_only_on_note/);
    expect(
      await refusal(upsertEmbeddings([row('chapter', crypto.randomUUID(), null, 'A')], handle)),
    ).toMatch(/embedding_recording_per_kind/);
  });
});

describe('the SQL visibility rule says what the pure one says (3.10.9)', () => {
  interface Seeded {
    readonly label: string;
    readonly id: string;
    readonly facts: EmbeddingVisibilityFacts;
  }

  let me: string;
  let somebodyElse: string;
  let seeded: Seeded[];

  beforeAll(async () => {
    me = await member('me');
    somebodyElse = await member('somebody-else');

    const live = await recording(true);
    const draft = await recording(false);
    const liveAt = new Date();

    // A published summary on the live recording, and a draft summary on a second live one.
    await publishSummary(live, 'The live summary.', handle);
    const [liveSummary] = await sql<{ id: string }[]>`select id from summary where recording_id = ${live}`;
    const liveWithDraft = await recording(true);
    await publishSummary(liveWithDraft, 'Returned to draft.', handle);
    await setSummaryPublication(liveWithDraft, false, handle);
    const [draftSummary] = await sql<{ id: string }[]>`
      select id from summary where recording_id = ${liveWithDraft}
    `;

    const myPrivate = await insertNote(
      { recordingId: live, authorId: me, visibility: 'private', text: 'Mine.', timestampMs: 0 },
      handle,
    );
    const theirPrivate = await insertNote(
      { recordingId: live, authorId: somebodyElse, visibility: 'private', text: 'Theirs.', timestampMs: 0 },
      handle,
    );
    const theirPublic = await insertNote(
      { recordingId: live, authorId: somebodyElse, visibility: 'public', text: 'Everyone.', timestampMs: 0 },
      handle,
    );
    const myPrivateOnDraft = await insertNote(
      { recordingId: draft, authorId: me, visibility: 'private', text: 'Mine, on a draft.', timestampMs: 0 },
      handle,
    );

    const segmentOnLive = crypto.randomUUID();
    const segmentOnDraft = crypto.randomUUID();
    const chapterOnLive = crypto.randomUUID();
    const seriesRow = crypto.randomUUID();

    await upsertEmbeddings(
      [
        row('segment', segmentOnLive, live, 'A line on a live teaching.'),
        row('segment', segmentOnDraft, draft, 'A line on an unpublished teaching.'),
        row('chapter', chapterOnLive, live, 'A chapter.'),
        row('summary', liveSummary?.id as string, live, 'The live summary.'),
        row('summary', draftSummary?.id as string, liveWithDraft, 'Returned to draft.'),
        row('note', myPrivate.id, live, 'Mine.', { ownerUserId: me }),
        row('note', theirPrivate.id, live, 'Theirs.', { ownerUserId: somebodyElse }),
        row('note', theirPublic.id, live, 'Everyone.'),
        row('note', myPrivateOnDraft.id, draft, 'Mine, on a draft.', { ownerUserId: me }),
        row('series', seriesRow, null, 'A series.'),
      ],
      handle,
    );

    seeded = [
      { label: 'segment on a live teaching', id: segmentOnLive, facts: facts('segment', liveAt) },
      { label: 'segment on an unpublished teaching', id: segmentOnDraft, facts: facts('segment', null) },
      { label: 'chapter on a live teaching', id: chapterOnLive, facts: facts('chapter', liveAt) },
      {
        label: 'published summary',
        id: liveSummary?.id as string,
        facts: { ...facts('summary', liveAt), summaryPublishedAt: liveAt },
      },
      {
        label: 'summary returned to draft',
        id: draftSummary?.id as string,
        facts: { ...facts('summary', liveAt), summaryPublishedAt: null },
      },
      { label: 'my private note', id: myPrivate.id, facts: { ...facts('note', liveAt), ownerUserId: me } },
      {
        label: "somebody else's private note",
        id: theirPrivate.id,
        facts: { ...facts('note', liveAt), ownerUserId: somebodyElse },
      },
      { label: "somebody else's public note", id: theirPublic.id, facts: facts('note', liveAt) },
      {
        label: 'my private note on an unpublished teaching',
        id: myPrivateOnDraft.id,
        facts: { ...facts('note', null), ownerUserId: me },
      },
      { label: 'a series', id: seriesRow, facts: facts('series', null) },
    ];
  }, 60_000);

  function facts(sourceKind: EmbeddingSourceKind, recordingPublishedAt: Date | null): EmbeddingVisibilityFacts {
    return { sourceKind, recordingPublishedAt, summaryPublishedAt: null, ownerUserId: null };
  }

  it('seeds every case the rule distinguishes — otherwise the agreement below is vacuous', () => {
    const answers = new Set(seeded.map((one) => isEmbeddingVisibleTo(me, one.facts)));
    expect(answers).toEqual(new Set([true, false]));
    expect(seeded.some((one) => one.facts.sourceKind === 'summary' && one.facts.summaryPublishedAt === null)).toBe(true);
    expect(seeded.some((one) => one.facts.ownerUserId === somebodyElse)).toBe(true);
    expect(seeded.some((one) => one.facts.recordingPublishedAt === null)).toBe(true);
  });

  it.each([['me'], ['somebody else']])('agrees with the pure rule, row by row, for %s', async (who) => {
    const readerId = who === 'me' ? me : somebodyElse;
    const visible = new Set((await listVisibleEmbeddings(readerId, handle)).map((one) => one.sourceId));

    for (const one of seeded) {
      expect(visible.has(one.id), `${one.label}, read as ${who}`).toBe(
        isEmbeddingVisibleTo(readerId, one.facts),
      );
    }
  });

  it('answers me my own private note and never theirs; them theirs and never mine', async () => {
    const mine = new Set((await listVisibleEmbeddings(me, handle)).map((one) => one.sourceId));
    const theirs = new Set((await listVisibleEmbeddings(somebodyElse, handle)).map((one) => one.sourceId));
    const myNote = seeded.find((one) => one.label === 'my private note')?.id as string;
    const theirNote = seeded.find((one) => one.label === "somebody else's private note")?.id as string;

    expect(mine.has(myNote)).toBe(true);
    expect(mine.has(theirNote)).toBe(false);
    expect(theirs.has(theirNote)).toBe(true);
    expect(theirs.has(myNote)).toBe(false);
  });

  it('leaves out a public note across a block, and answers it again once the block lifts (finding 7)', async () => {
    const theirPublic = seeded.find((one) => one.label === "somebody else's public note")?.id as string;
    const blocked = { ...facts('note', new Date()), authorBlocked: true };
    expect(isEmbeddingVisibleTo(me, blocked)).toBe(false);

    await insertMemberBlock(me, somebodyElse, handle);
    try {
      const mine = new Set((await listVisibleEmbeddings(me, handle)).map((one) => one.sourceId));
      const theirs = new Set((await listVisibleEmbeddings(somebodyElse, handle)).map((one) => one.sourceId));
      expect(mine.has(theirPublic)).toBe(false);
      // The author still sees their own; the block hides the other party, not oneself.
      expect(theirs.has(theirPublic)).toBe(true);
    } finally {
      await deleteMemberBlock(me, somebodyElse, handle);
    }
    const again = new Set((await listVisibleEmbeddings(me, handle)).map((one) => one.sourceId));
    expect(again.has(theirPublic)).toBe(true);
  });

  it('shows nobody the draft summary, the unpublished teaching, or the series', async () => {
    for (const readerId of [me, somebodyElse]) {
      const visible = new Set((await listVisibleEmbeddings(readerId, handle)).map((one) => one.sourceId));
      for (const label of [
        'summary returned to draft',
        'segment on an unpublished teaching',
        'my private note on an unpublished teaching',
        'a series',
      ]) {
        const id = seeded.find((one) => one.label === label)?.id as string;
        expect(visible.has(id), label).toBe(false);
      }
    }
  });
});
