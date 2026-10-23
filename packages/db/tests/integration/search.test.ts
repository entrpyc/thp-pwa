import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  createDatabase,
  ensureTags,
  insertNote,
  insertRecording,
  insertSeries,
  insertUser,
  listSegments,
  listChapters,
  publishSummary,
  replaceChapters,
  replaceRecordingTags,
  replaceScriptureReferences,
  replaceSeriesTags,
  replaceTranscript,
  runMigrations,
  searchEmbeddings,
  setRecordingPublication,
  setRecordingSeries,
  setSummaryPublication,
  upsertEmbeddings,
  type DatabaseHandle,
  type NewEmbedding,
  type SearchFilters,
  type SearchHitRow,
} from '@thp/db';
import { fakeVector } from '@thp/embed';
import { EMBEDDING_DIMENSIONS, type EmbeddingSourceKind } from '@thp/shared';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * **The search query against a real database** ([3.10](docs/project/prd.md); project tdd 4.5).
 *
 * Rows are written the way the embed step writes them — one per segment, chapter and note, with
 * the fake embedder's vector for the text — and the query is driven with vectors from the same
 * fake, so "the query is the words of this line" is a cosine distance of zero and nothing else is
 * near it. The fake is not semantic, and no test here pretends it is: what is asserted is the
 * *machinery* — that visibility holds inside the top-k, that every filter narrows, that an exact
 * citation is found by its words, and that a row both arms place outranks a row either places
 * alone.
 */

let target: ThrowawayDatabase;
let handle: DatabaseHandle;
let made = 0;

const NO_FILTERS: SearchFilters = {
  seriesId: null,
  recordedFrom: null,
  recordedTo: null,
  tagId: null,
  book: null,
  onlyMine: false,
};

async function member(label: string): Promise<string> {
  made += 1;
  const row = await insertUser(
    { email: `${label}-${made}@example.test`, passwordHash: 'hash', displayName: label, role: 'member' },
    handle,
  );
  return row.id;
}

async function recording(title: string, recordedAt: string, published = true): Promise<string> {
  made += 1;
  const row = await insertRecording(
    { originalMediaKey: `originals/search-${made}.mp3`, title, recordedAt },
    handle,
  );
  if (published) await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

function embeddingOf(
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
    vector: fakeVector(text),
    model: 'fake-embed-1',
    ...extras,
  };
}

/** A transcript of these lines, ten seconds each, embedded as the step would embed it. */
async function transcriptOf(recordingId: string, lines: readonly string[]) {
  const transcript = await replaceTranscript(
    {
      recordingId,
      language: 'en',
      confidence: 0.9,
      segments: lines.map((text, index) => ({
        startMs: index * 10_000,
        endMs: (index + 1) * 10_000,
        text,
      })),
    },
    handle,
  );
  const segments = await listSegments(transcript.id, handle);
  await upsertEmbeddings(
    segments.map((segment) => embeddingOf('segment', segment.id, recordingId, segment.text)),
    handle,
  );
  return segments;
}

async function search(
  readerId: string,
  queryText: string,
  options: { readonly vector?: readonly number[] | null; readonly filters?: Partial<SearchFilters> } = {},
): Promise<SearchHitRow[]> {
  return searchEmbeddings(
    {
      readerId,
      queryText,
      queryVector: options.vector === undefined ? fakeVector(queryText) : options.vector,
      filters: { ...NO_FILTERS, ...options.filters },
      perArm: 40,
      limit: 20,
    },
    handle,
  );
}

beforeAll(async () => {
  target = await createThrowawayDatabase(inject('databaseUrl'), 'search');
  await runMigrations({ url: target.url });
  handle = createDatabase({ url: target.url, max: 4 });
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await target?.drop();
}, 60_000);

describe('visibility holds inside the ranking (3.10.9)', () => {
  it('answers published rows and the reader’s own private notes, and never the rest', async () => {
    const reader = await member('reader');
    const other = await member('other');
    const shown = await recording('Visible teaching', '2026-01-10');
    const hidden = await recording('Hidden teaching', '2026-01-11', false);

    const line = 'The vine and the branches abide together.';
    await transcriptOf(shown, [line]);
    await transcriptOf(hidden, [line]);

    const mine = await insertNote(
      { recordingId: shown, authorId: reader, visibility: 'private', timestampMs: 0, text: `My private thought: ${line}` },
      handle,
    );
    const theirs = await insertNote(
      { recordingId: shown, authorId: other, visibility: 'private', timestampMs: 0, text: `Their private thought: ${line}` },
      handle,
    );
    const shared = await insertNote(
      { recordingId: shown, authorId: other, visibility: 'public', timestampMs: 0, text: `A shared thought: ${line}` },
      handle,
    );
    await upsertEmbeddings(
      [
        embeddingOf('note', mine.id, shown, mine.text ?? '', { ownerUserId: reader }),
        embeddingOf('note', theirs.id, shown, theirs.text ?? '', { ownerUserId: other }),
        embeddingOf('note', shared.id, shown, shared.text ?? ''),
      ],
      handle,
    );

    const hits = await search(reader, 'vine branches abide');
    const sources = hits.map((hit) => hit.sourceId);
    expect(hits.every((hit) => hit.recordingId === shown)).toBe(true);
    expect(sources).toContain(mine.id);
    expect(sources).toContain(shared.id);
    expect(sources).not.toContain(theirs.id);
    // The unpublished teaching's line says the same words and is not there.
    expect(hits.filter((hit) => hit.sourceKind === 'segment')).toHaveLength(1);
  });

  it('leaves the published summary out — the kinds searched are segments, chapters and notes', async () => {
    const reader = await member('reader');
    const id = await recording('Summarised teaching', '2026-02-01');
    const words = 'Grace upon grace, the summary says.';
    const summary = await publishSummary(id, words, handle);
    await setSummaryPublication(id, true, handle);
    await upsertEmbeddings([embeddingOf('summary', summary.id, id, words)], handle);
    const [segment] = await transcriptOf(id, ['Grace upon grace, the teacher says.']);

    // The vector arm answers its nearest rows whatever their distance, so other suites' lines may
    // trail in; what is asserted is that the summary's words are matched by neither arm.
    const hits = await search(reader, 'Grace upon grace');
    expect(hits.map((hit) => hit.sourceId)).toContain(segment?.id);
    expect(hits.map((hit) => hit.sourceId)).not.toContain(summary.id);
    expect(hits.some((hit) => (hit.sourceKind as string) === 'summary')).toBe(false);
  });
});

describe('each filter narrows (3.10.8)', () => {
  let reader: string;
  let inSeries: string;
  let loose: string;
  let seriesId: string;
  let tagId: string;
  let seriesTagId: string;
  const line = 'Consider the lilies of the field.';

  beforeAll(async () => {
    reader = await member('reader');
    seriesId = (await insertSeries({ title: 'Sermon on the Mount', description: null }, handle)).id;
    inSeries = await recording('In the series', '2026-03-05');
    loose = await recording('Outside the series', '2025-06-01');
    await setRecordingSeries(inSeries, seriesId, handle);
    await transcriptOf(inSeries, [line]);
    await transcriptOf(loose, [line]);

    const [lilies, mount] = await ensureTags(['lilies', 'mount'], handle);
    tagId = lilies?.id ?? '';
    seriesTagId = mount?.id ?? '';
    await replaceRecordingTags(loose, [tagId], handle);
    await replaceSeriesTags(seriesId, [seriesTagId], handle);

    await replaceScriptureReferences(
      inSeries,
      [{ book: 'matthew', chapter: 6, verseStart: 28, verseEnd: 28, origin: 'machine', editedByAdmin: false, anchorMs: 0 }],
      handle,
    );
  });

  it('by series', async () => {
    const hits = await search(reader, line, { filters: { seriesId } });
    expect(hits.map((hit) => hit.recordingId)).toEqual([inSeries]);
    expect(hits[0]?.seriesTitle).toBe('Sermon on the Mount');
  });

  it('by date range, inclusive over the day recorded', async () => {
    const before = await search(reader, line, { filters: { recordedTo: '2025-12-31' } });
    expect(before.map((hit) => hit.recordingId)).toEqual([loose]);
    const onTheDay = await search(reader, line, {
      filters: { recordedFrom: '2026-03-05', recordedTo: '2026-03-05' },
    });
    expect(onTheDay.map((hit) => hit.recordingId)).toEqual([inSeries]);
  });

  it('by tag — on the recording, or on the series it is in', async () => {
    const own = await search(reader, line, { filters: { tagId } });
    expect(own.map((hit) => hit.recordingId)).toEqual([loose]);
    const inherited = await search(reader, line, { filters: { tagId: seriesTagId } });
    expect(inherited.map((hit) => hit.recordingId)).toEqual([inSeries]);
  });

  it('by scripture book', async () => {
    const hits = await search(reader, line, { filters: { book: 'matthew' } });
    expect(hits.map((hit) => hit.recordingId)).toEqual([inSeries]);
    expect(await search(reader, line, { filters: { book: 'romans' } })).toEqual([]);
  });

  it('to the reader’s own notes, public and private alike (3.10.10)', async () => {
    const other = await member('other');
    const mine = await insertNote(
      { recordingId: loose, authorId: reader, visibility: 'public', timestampMs: 0, text: `Lilies, I wrote publicly.` },
      handle,
    );
    const minePrivate = await insertNote(
      { recordingId: loose, authorId: reader, visibility: 'private', timestampMs: 0, text: `Lilies, I wrote privately.` },
      handle,
    );
    const theirs = await insertNote(
      { recordingId: loose, authorId: other, visibility: 'public', timestampMs: 0, text: `Lilies, somebody else wrote.` },
      handle,
    );
    await upsertEmbeddings(
      [
        embeddingOf('note', mine.id, loose, mine.text ?? ''),
        embeddingOf('note', minePrivate.id, loose, minePrivate.text ?? '', { ownerUserId: reader }),
        embeddingOf('note', theirs.id, loose, theirs.text ?? ''),
      ],
      handle,
    );

    const hits = await search(reader, 'lilies', { filters: { onlyMine: true } });
    expect(hits.map((hit) => hit.sourceId).sort()).toEqual([mine.id, minePrivate.id].sort());
    expect(hits.every((hit) => hit.sourceKind === 'note')).toBe(true);
  });
});

describe('an exact citation is found by its words (3.10.5)', () => {
  it('matches the line that says it, with its neighbours for context, and no line that does not', async () => {
    const reader = await member('reader');
    const id = await recording('Romans teaching', '2026-04-01');
    const segments = await transcriptOf(id, [
      'Let us open our Bibles.',
      'Turn with me to Romans 8:28 this morning.',
      'All things work together for good.',
    ]);

    // A vector from unrelated words, so only the word arm can place the line — and it is still
    // first, because the vector arm's nearest rows are all one-arm rows too and it has two ranks.
    const hits = await search(reader, 'Romans 8:28', { vector: fakeVector('something else entirely') });
    expect(hits[0]?.sourceId).toBe(segments[1]?.id);
    const cited = hits[0];
    expect(cited?.textRank).toBe(1);
    expect(cited?.startMs).toBe(10_000);
    expect(cited?.before).toBe('Let us open our Bibles.');
    expect(cited?.after).toBe('All things work together for good.');
    // On words alone, the lines around it are not matches at all.
    const wordsOnly = await search(reader, 'Romans 8:28', { vector: null });
    expect(wordsOnly.map((hit) => hit.sourceId)).toEqual([segments[1]?.id]);
  });

  it('runs on words alone when there is no vector, which is the degraded search', async () => {
    const reader = await member('reader');
    const id = await recording('Words-only teaching', '2026-04-02');
    const [segment] = await transcriptOf(id, ['Blessed are the peacemakers.']);
    const hits = await search(reader, 'peacemakers', { vector: null });
    expect(hits.map((hit) => hit.sourceId)).toEqual([segment?.id]);
    expect(hits[0]?.vectorRank).toBeNull();
    expect(hits[0]?.textRank).toBe(1);
  });
});

describe('the fusion order (project tdd 4.5)', () => {
  it('ranks a row both arms place above a row either places alone', async () => {
    const reader = await member('reader');
    const id = await recording('Fusion teaching', '2026-05-01');
    const query = 'the shepherd leaves the ninety-nine';
    const chapters = await replaceChapters(
      id,
      [
        { startMs: 0, title: 'Both arms', summary: query },
        { startMs: 10_000, title: 'Meaning only', summary: 'Nothing in common with the words.' },
        { startMs: 20_000, title: 'Words only', summary: `A long chapter in which the shepherd leaves the ninety-nine and many other things besides.` },
        { startMs: 30_000, title: 'Neither', summary: 'Unrelated entirely.' },
      ],
      { model: 'fake' },
      handle,
    );
    const [both, meaning, words, neither] = await listChapters(id, handle);

    // The meaning-only row's vector leans towards the query without being it, so it is the vector
    // arm's second nearest and nothing the word arm can see.
    const near = blend(fakeVector(`Both arms\n\n${query}`), fakeVector('far away'), 0.9);
    await upsertEmbeddings(
      [
        embeddingOf('chapter', both?.id ?? '', id, `Both arms\n\n${query}`),
        embeddingOf('chapter', meaning?.id ?? '', id, 'Meaning only\n\nNothing in common with the words.', { vector: near }),
        embeddingOf('chapter', words?.id ?? '', id, `Words only\n\n${words?.summary ?? ''}`),
        embeddingOf('chapter', neither?.id ?? '', id, 'Neither\n\nUnrelated entirely.'),
      ],
      handle,
    );
    expect(chapters).toHaveLength(4);

    const hits = await search(reader, query, { vector: fakeVector(`Both arms\n\n${query}`) });
    expect(hits[0]?.sourceId).toBe(both?.id);
    expect(hits[0]?.vectorRank).toBe(1);
    expect(hits[0]?.textRank).toBe(1);
    // Behind it, in some order, the two single-arm rows: second nearest by meaning, second by words.
    // The vector arm answers its nearest rows whatever their distance, so the fourth chapter and
    // other suites' lines trail in after those two, each with a single, worse rank.
    expect(hits.slice(1, 3).map((hit) => hit.sourceId).sort()).toEqual([meaning?.id, words?.id].sort());
    const fourth = hits.findIndex((hit) => hit.sourceId === neither?.id);
    expect(fourth === -1 || fourth >= 3).toBe(true);
    // Every row's score is the sum of its reciprocal ranks, so the first is strictly ahead.
    expect(hits[0]?.score ?? 0).toBeGreaterThan(hits[1]?.score ?? 0);
    expect(hits[0]?.sourceKind).toBe('chapter');
    expect(hits[0]?.startMs).toBe(0);
  });
});

/** A unit vector between two others — close to the first, and not equal to it. */
function blend(a: readonly number[], b: readonly number[], weight: number): number[] {
  const raw = Array.from({ length: EMBEDDING_DIMENSIONS }, (_unused, index) =>
    weight * (a[index] ?? 0) + (1 - weight) * (b[index] ?? 0),
  );
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return raw.map((value) => value / norm);
}
