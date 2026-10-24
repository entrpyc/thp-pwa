import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  correctSegment,
  createDatabase,
  enqueueJob,
  findEmbeddingsForSources,
  findUnfinishedJob,
  insertNote,
  insertRecording,
  insertSeries,
  insertUser,
  listChapters,
  listEmbeddingsForRecording,
  listSegments,
  publishSummary,
  replaceChapters,
  replaceTranscript,
  runMigrations,
  setRecordingDescription,
  setRecordingPublication,
  setRecordingSeries,
  setSummaryPublication,
  softDeleteNote,
  updateChapter,
  type DatabaseHandle,
  type EmbeddingRow,
  type JobRow,
} from '@thp/db';
import { PIPELINE_STEPS, type PipelineStep } from '@thp/shared';
import { DOMAIN_EVENT_MESSAGE } from '@thp/shared/observability/events';
import { setLogSink, type LogLine } from '@thp/shared/observability/logger';
import { fakeEmbedder, fakeVector, type Embedder } from '../../src/embed';
import { EMBED_BATCH_SIZE } from '../../src/embed-recording';
import { fakeGenerator } from '../../src/generate';
import { createHandlers } from '../../src/handlers';
import { runJob } from '../../src/run-job';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * **The `embed` step, against a real database** (project tdd 4.4, [3.5.5](docs/project/prd.md),
 * [3.10.9](docs/project/prd.md), [3.22.7](docs/project/prd.md)).
 *
 * **The provider is the only thing faked**, by configuration rather than by a mock — an `Embedder`
 * is handed in exactly as the loop is handed a handler registry. Everything else is real, because
 * everything else is what the requirements are about: rows that genuinely replace rather than
 * accumulate, a correction that genuinely changes one vector and no other, a private note whose
 * owner genuinely reaches the column the visibility rule reads, and a chain that genuinely ends on
 * this step.
 *
 * The property this suite exists for above all others is **reconciliation**: one handler, run
 * after the chain, after a correction, after a chapter edit, after a note, or by an admin, and in
 * every case the table ends up describing the recording as it is now — spending only on what
 * changed.
 */

const databaseUrl = inject('databaseUrl');

const SEGMENTS = [
  { startMs: 0, endMs: 4000, text: 'Good morning, and welcome.' },
  { startMs: 4000, endMs: 9000, text: 'We are reading from Paul today.' },
  { startMs: 9000, endMs: 15_000, text: 'A word about Epafras before we begin.' },
  { startMs: 15_000, endMs: 24_000, text: 'Turn with me to the second chapter.' },
] as const;

/** The four sentences are one passage window — short, and inside a minute — so one row holds them all. */
const WINDOW_TEXT = SEGMENTS.map((one) => one.text).join(' ');

const CHAPTERS = [
  { startMs: 0, title: 'Welcome', summary: 'The greeting.', editedByAdmin: false },
  { startMs: 9000, title: 'Epaphras', summary: 'Who he was.', editedByAdmin: false },
] as const;

/**
 * Forty seconds a line: two lines span eighty, past the window's minute, so every line is a window
 * of its own. What a test about *many rows* wants, without a transcript of ten thousand words.
 */
const ONE_WINDOW_PER_LINE_MS = 40_000;

let target: ThrowawayDatabase;
let sql: postgres.Sql;
let handle: DatabaseHandle;
let made = 0;
let captured: LogLine[] = [];
let restoreSink: () => void;

interface Seeded {
  readonly recordingId: string;
  readonly title: string;
  readonly segmentIds: readonly string[];
  readonly chapterIds: readonly string[];
}

/** A recording with a transcript and chapters, published unless said otherwise. */
async function teaching(options: { published?: boolean; transcript?: boolean } = {}): Promise<Seeded> {
  made += 1;
  const title = `Teaching ${made}`;
  const recording = await insertRecording(
    {
      originalMediaKey: `originals/embed-${made}-${Date.now().toString(36)}.mp3`,
      title,
      recordedAt: '2026-10-01',
    },
    handle,
  );
  let segmentIds: string[] = [];
  let chapterIds: string[] = [];
  if (options.transcript !== false) {
    const transcript = await replaceTranscript(
      { recordingId: recording.id, language: 'en', confidence: 0.95, segments: [...SEGMENTS] },
      handle,
    );
    segmentIds = (await listSegments(transcript.id, handle)).map((one) => one.id);
    await replaceChapters(recording.id, [...CHAPTERS], { model: 'fake' }, handle);
    chapterIds = (await listChapters(recording.id, handle)).map((one) => one.id);
  }
  if (options.published !== false) await setRecordingPublication(recording.id, new Date(), handle);
  return { recordingId: recording.id, title, segmentIds, chapterIds };
}

async function member(label: string): Promise<string> {
  made += 1;
  const row = await insertUser(
    { email: `${label}-${made}@example.test`, passwordHash: 'hash', displayName: label, role: 'member' },
    handle,
  );
  return row.id;
}

async function claimed(recordingId: string, step: PipelineStep = 'embed'): Promise<JobRow> {
  const job = await enqueueJob(
    { recordingId, step, correlationId: `embed-${made}-${Math.random().toString(36).slice(2)}` },
    handle,
  );
  await sql`update job set status = 'running', started_at = now() where id = ${job.id}`;
  return { ...job, status: 'running', startedAt: new Date() };
}

function run(job: JobRow, embedder: Embedder = fakeEmbedder()): Promise<JobRow> {
  return runJob(
    job,
    createHandlers({ embedder, generator: fakeGenerator({ summary: 's', description: 'd' }), executor: handle }),
    { executor: handle },
  );
}

/** The rows for a recording, keyed `kind:sourceId`, so two runs can be compared. */
async function rowsOf(recordingId: string): Promise<Map<string, EmbeddingRow>> {
  const rows = await listEmbeddingsForRecording(recordingId, handle);
  return new Map(rows.map((row) => [`${row.sourceKind}:${row.sourceId}`, row]));
}

async function storedVector(sourceId: string): Promise<number[]> {
  const [row] = await sql<{ embedding: string }[]>`
    select embedding::text as embedding from embedding where source_id = ${sourceId}
  `;
  return JSON.parse(row?.embedding ?? '[]') as number[];
}

beforeAll(async () => {
  target = await createThrowawayDatabase(databaseUrl, 'embed');
  await runMigrations({ url: target.url });
  sql = postgres(target.url, { max: 4, onnotice: () => {} });
  handle = createDatabase({ url: target.url, max: 6 });
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await sql?.end({ timeout: 5 });
  await target?.drop();
}, 60_000);

beforeEach(() => {
  captured = [];
  restoreSink = setLogSink((line) => captured.push(line));
  return () => restoreSink();
});

describe('what the step embeds', () => {
  it('writes one row per passage window, per chapter, and one for the recording, under the model that produced them', async () => {
    const seeded = await teaching();
    const embedder = fakeEmbedder();
    const row = await run(await claimed(seeded.recordingId), embedder);
    expect(row.status).toBe('succeeded');

    // Four short sentences inside twenty-four seconds are one window, keyed on the first — so one
    // segment row, not four. The transcript is embedded as the passage it is.
    const rows = await rowsOf(seeded.recordingId);
    expect([...rows.keys()].sort()).toEqual(
      [
        `segment:${seeded.segmentIds[0]}`,
        ...seeded.chapterIds.map((id) => `chapter:${id}`),
        `recording:${seeded.recordingId}`,
      ].sort(),
    );
    for (const one of rows.values()) {
      expect(one.model).toBe(embedder.model);
      expect(one.recordingId).toBe(seeded.recordingId);
      expect(one.ownerUserId).toBeNull();
    }
    // The window's sentences joined, with its extent on the row; the chapter's title and summary
    // as one text; the recording's title — nothing else is written about it yet.
    const window = rows.get(`segment:${seeded.segmentIds[0]}`);
    expect(window?.text).toBe(WINDOW_TEXT);
    expect(window?.windowFirstSegmentId).toBe(seeded.segmentIds[0]);
    expect(window?.windowLastSegmentId).toBe(seeded.segmentIds[SEGMENTS.length - 1]);
    expect(rows.get(`chapter:${seeded.chapterIds[0]}`)?.text).toBe('Welcome\n\nThe greeting.');
    const own = rows.get(`recording:${seeded.recordingId}`);
    expect(own?.text).toBe(seeded.title);
    expect(own?.windowFirstSegmentId).toBeNull();

    // The vector stored is the one the embedder answered for the window's words.
    const vector = await storedVector(seeded.segmentIds[0] as string);
    const expected = fakeVector(WINDOW_TEXT);
    expect(vector).toHaveLength(expected.length);
    vector.forEach((value, index) => expect(value).toBeCloseTo(expected[index] as number, 6));
  });

  it('records what it spent and what it did on the job row', async () => {
    const seeded = await teaching();
    const row = await run(await claimed(seeded.recordingId));
    expect(row.providerMeta).toMatchObject({
      provider: 'fake',
      costUsd: 0,
      inputTokens: 0,
      requests: 1,
      embedded: 1 + CHAPTERS.length + 1,
      unchanged: 0,
      removed: 0,
      windows: 1,
      passes: 2,
    });
  });

  it('writes the recording’s own words — title, description, series and the summary’s opening — and follows their gates', async () => {
    const seeded = await teaching();
    await setRecordingDescription(seeded.recordingId, 'A teaching on Colossians.', handle);
    const series = await insertSeries({ title: 'Colossians', description: null }, handle);
    await setRecordingSeries(seeded.recordingId, series.id, handle);
    await publishSummary(seeded.recordingId, 'First paragraph.\n\nSecond paragraph.', handle);
    await setSummaryPublication(seeded.recordingId, false, handle);

    // A draft summary contributes nothing, as it has no row of its own.
    await run(await claimed(seeded.recordingId));
    expect((await rowsOf(seeded.recordingId)).get(`recording:${seeded.recordingId}`)?.text).toBe(
      `${seeded.title}\n\nA teaching on Colossians.\n\nSeries: Colossians`,
    );

    // Published, its first paragraph joins the text and only that row is re-embedded for it.
    await setSummaryPublication(seeded.recordingId, true, handle);
    const embedder = fakeEmbedder();
    await run(await claimed(seeded.recordingId), embedder);
    expect((await rowsOf(seeded.recordingId)).get(`recording:${seeded.recordingId}`)?.text).toBe(
      `${seeded.title}\n\nA teaching on Colossians.\n\nSeries: Colossians\n\nFirst paragraph.`,
    );
    expect(embedder.calls.flat().sort()).toEqual(
      ['First paragraph.\n\nSecond paragraph.', `${seeded.title}\n\nA teaching on Colossians.\n\nSeries: Colossians\n\nFirst paragraph.`].sort(),
    );
  });

  it('leaves a draft summary out, and embeds it once it is published', async () => {
    const seeded = await teaching();
    await publishSummary(seeded.recordingId, 'The summary.', handle);
    await setSummaryPublication(seeded.recordingId, false, handle);
    const [summary] = await sql<{ id: string }[]>`
      select id from summary where recording_id = ${seeded.recordingId}
    `;
    const summaryId = summary?.id as string;

    await run(await claimed(seeded.recordingId));
    expect(await findEmbeddingsForSources('summary', [summaryId], handle)).toEqual([]);

    await setSummaryPublication(seeded.recordingId, true, handle);
    await run(await claimed(seeded.recordingId));
    const [embedded] = await findEmbeddingsForSources('summary', [summaryId], handle);
    expect(embedded?.text).toBe('The summary.');

    // And back to draft takes it out again — the step removes a source it no longer finds.
    await setSummaryPublication(seeded.recordingId, false, handle);
    await run(await claimed(seeded.recordingId));
    expect(await findEmbeddingsForSources('summary', [summaryId], handle)).toEqual([]);
  });

  it('embeds public and private notes alike, with the owner on the private one and nothing else', async () => {
    const seeded = await teaching();
    const me = await member('me');
    const mine = await insertNote(
      { recordingId: seeded.recordingId, authorId: me, visibility: 'private', text: 'For me.', timestampMs: 0 },
      handle,
    );
    const everyone = await insertNote(
      { recordingId: seeded.recordingId, authorId: me, visibility: 'public', text: 'For all.', timestampMs: 0 },
      handle,
    );
    const reply = await insertNote(
      { recordingId: seeded.recordingId, authorId: me, visibility: 'public', text: 'A reply.', parentId: everyone.id },
      handle,
    );

    await run(await claimed(seeded.recordingId));
    const rows = await rowsOf(seeded.recordingId);

    expect(rows.get(`note:${mine.id}`)).toMatchObject({ text: 'For me.', ownerUserId: me });
    expect(rows.get(`note:${everyone.id}`)).toMatchObject({ text: 'For all.', ownerUserId: null });
    expect(rows.get(`note:${reply.id}`)).toMatchObject({ text: 'A reply.', ownerUserId: null });
  });

  it('drops a tombstoned note on the next run, and never writes one', async () => {
    const seeded = await teaching();
    const me = await member('me');
    const gone = await insertNote(
      { recordingId: seeded.recordingId, authorId: me, visibility: 'public', text: 'Soon gone.', timestampMs: 0 },
      handle,
    );
    await run(await claimed(seeded.recordingId));
    expect((await rowsOf(seeded.recordingId)).has(`note:${gone.id}`)).toBe(true);

    await softDeleteNote(gone.id, me, handle);
    const row = await run(await claimed(seeded.recordingId));
    expect((await rowsOf(seeded.recordingId)).has(`note:${gone.id}`)).toBe(false);
    expect(row.providerMeta).toMatchObject({ removed: 1, embedded: 0 });
  });

  it('writes only the recording’s own row for a teaching with no transcript', async () => {
    const seeded = await teaching({ transcript: false });
    const row = await run(await claimed(seeded.recordingId));
    expect(row.status).toBe('succeeded');
    const rows = await listEmbeddingsForRecording(seeded.recordingId, handle);
    expect(rows.map((one) => [one.sourceKind, one.sourceId])).toEqual([['recording', seeded.recordingId]]);
    expect(row.providerMeta).toMatchObject({ requests: 1, embedded: 1, windows: 0 });
  });

  it('fails the job, spending nothing, when the embedder refuses', async () => {
    const seeded = await teaching();
    const refusing: Embedder = {
      name: 'refusing',
      model: 'refusing-1',
      embed: async () => {
        throw new Error('the provider refused the request with HTTP 429');
      },
    };
    const row = await run(await claimed(seeded.recordingId), refusing);

    expect(row.status).toBe('failed');
    expect(row.error).toContain('HTTP 429');
    // Nothing half-written: the write is one transaction after every call has answered.
    expect(await listEmbeddingsForRecording(seeded.recordingId, handle)).toEqual([]);
    expect(captured.some((line) => line.message === 'embed.failed')).toBe(true);
  });
});

describe('reconciliation: running it again (at-least-once dispatch, 3.21.2.4)', () => {
  it('spends nothing and changes nothing when the words are unchanged', async () => {
    const seeded = await teaching();
    await run(await claimed(seeded.recordingId));
    const before = await rowsOf(seeded.recordingId);

    const embedder = fakeEmbedder();
    const row = await run(await claimed(seeded.recordingId), embedder);

    expect(embedder.calls).toEqual([]);
    expect(row.providerMeta).toMatchObject({
      requests: 0,
      embedded: 0,
      unchanged: before.size,
      removed: 0,
      passes: 1,
    });
    const after = await rowsOf(seeded.recordingId);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [key, one] of after) {
      expect(one.id).toBe(before.get(key)?.id);
      expect(one.updatedAt).toEqual(before.get(key)?.updatedAt);
    }
  });

  it('re-embeds every source when the model changed, since two models’ vectors do not compare', async () => {
    const seeded = await teaching();
    await run(await claimed(seeded.recordingId));

    const fake = fakeEmbedder();
    const newer: Embedder = {
      name: 'fake',
      model: 'fake-embed-2',
      async embed(texts) {
        const result = await fake.embed(texts);
        return { ...result, spend: { ...result.spend, model: 'fake-embed-2' } };
      },
    };
    const row = await run(await claimed(seeded.recordingId), newer);

    expect(row.providerMeta).toMatchObject({ embedded: 1 + CHAPTERS.length + 1, unchanged: 0 });
    for (const one of (await rowsOf(seeded.recordingId)).values()) expect(one.model).toBe('fake-embed-2');
  });

  it('embeds in batches no larger than the batch size', async () => {
    made += 1;
    const recording = await insertRecording(
      { originalMediaKey: `originals/long-${made}.mp3`, title: 'Long', recordedAt: '2026-10-01' },
      handle,
    );
    // One window per line, plus the recording's own row: sixty-nine windows and one more.
    const lines = EMBED_BATCH_SIZE + 5;
    await replaceTranscript(
      {
        recordingId: recording.id,
        language: 'en',
        confidence: 0.95,
        segments: Array.from({ length: lines }, (_unused, index) => ({
          startMs: index * ONE_WINDOW_PER_LINE_MS,
          endMs: (index + 1) * ONE_WINDOW_PER_LINE_MS,
          text: `Line ${index + 1} of the long teaching.`,
        })),
      },
      handle,
    );

    const embedder = fakeEmbedder();
    await run(await claimed(recording.id), embedder);

    expect(embedder.calls.map((call) => call.length)).toEqual([EMBED_BATCH_SIZE, 5 + 1]);
    expect((await rowsOf(recording.id)).size).toBe(lines + 1);
  });
});

describe('re-embedding after a correction (3.5.5) and a chapter edit (3.22.7)', () => {
  it('replaces the rows of the windows that hold the corrected line, and only those', async () => {
    const seeded = await teaching();
    await run(await claimed(seeded.recordingId));
    const before = await rowsOf(seeded.recordingId);
    const corrected = seeded.segmentIds[2] as string;
    const windowKey = `segment:${seeded.segmentIds[0]}`;
    const vectorBefore = await storedVector(seeded.segmentIds[0] as string);

    await correctSegment(
      {
        id: corrected,
        text: 'A word about Epaphras before we begin.',
        startMs: 9000,
        endMs: 15_000,
        correctedByUserId: await member('admin'),
      },
      handle,
    );

    // One call, one text: the one window that holds the corrected sentence, re-joined, and
    // nothing else went to the provider. The row is keyed on the window's first sentence, not on
    // the sentence that changed.
    const correctedWindow = WINDOW_TEXT.replace('Epafras', 'Epaphras');
    const embedder = fakeEmbedder();
    const row = await run(await claimed(seeded.recordingId), embedder);
    expect(embedder.calls).toEqual([[correctedWindow]]);
    expect(row.providerMeta).toMatchObject({ embedded: 1, unchanged: before.size - 1, removed: 0 });

    const after = await rowsOf(seeded.recordingId);
    expect(after.size).toBe(before.size);
    const replaced = after.get(windowKey);
    expect(replaced?.id).toBe(before.get(windowKey)?.id);
    expect(replaced?.text).toBe(correctedWindow);
    expect(await storedVector(seeded.segmentIds[0] as string)).not.toEqual(vectorBefore);

    // Every other row is untouched — same id, same updated_at.
    for (const [key, one] of after) {
      if (key === windowKey) continue;
      expect(one.updatedAt, key).toEqual(before.get(key)?.updatedAt);
    }
  });

  it('re-embeds only the windows a corrected line falls in when the transcript has several', async () => {
    made += 1;
    const recording = await insertRecording(
      { originalMediaKey: `originals/windows-${made}.mp3`, title: 'Windows', recordedAt: '2026-10-01' },
      handle,
    );
    // Twelve lines of twenty-five words, five seconds each: windows of six lines stepping by three
    // (0–5, 3–8, 6–11), so the middle lines sit in two windows and the first three in one.
    const line = (index: number) =>
      `${Array.from({ length: 24 }, (_unused, word) => `w${index}x${word}`).join(' ')} end.`;
    const transcript = await replaceTranscript(
      {
        recordingId: recording.id,
        language: 'en',
        confidence: 0.95,
        segments: Array.from({ length: 12 }, (_unused, index) => ({
          startMs: index * 5_000,
          endMs: (index + 1) * 5_000,
          text: line(index),
        })),
      },
      handle,
    );
    const ids = (await listSegments(transcript.id, handle)).map((one) => one.id);
    await run(await claimed(recording.id));
    const windows = [...(await rowsOf(recording.id)).values()].filter((one) => one.sourceKind === 'segment');
    expect(windows.map((one) => one.sourceId).sort()).toEqual([ids[0], ids[3], ids[6]].sort());

    // Line 4 is in the first two windows (0–5 and 3–8) and no other. The correction keeps the
    // word count, so the window boundaries stay where they were — a correction that changed it
    // could legitimately move the windows after it, and that is the builder's rule, not a leak.
    const corrected = `${Array.from({ length: 24 }, (_unused, word) => `fixed4x${word}`).join(' ')} end.`;
    await correctSegment(
      { id: ids[4] as string, text: corrected, startMs: 20_000, endMs: 25_000, correctedByUserId: await member('admin') },
      handle,
    );
    const embedder = fakeEmbedder();
    const row = await run(await claimed(recording.id), embedder);
    expect(row.providerMeta).toMatchObject({ embedded: 2, removed: 0 });
    expect(embedder.calls.flat()).toHaveLength(2);
    expect(embedder.calls.flat().every((text) => text.includes('fixed4x0'))).toBe(true);
  });

  it('replaces a retitled chapter’s row and ignores a boundary move that changed no words', async () => {
    const seeded = await teaching();
    await run(await claimed(seeded.recordingId));
    const before = await rowsOf(seeded.recordingId);
    const chapterId = seeded.chapterIds[1] as string;

    // A boundary move alone: the title and summary are what is embedded, and they did not change.
    await updateChapter({ id: chapterId, title: 'Epaphras', summary: 'Who he was.', startMs: 15_000 }, handle);
    const quiet = fakeEmbedder();
    await run(await claimed(seeded.recordingId), quiet);
    expect(quiet.calls).toEqual([]);

    await updateChapter({ id: chapterId, title: 'Epaphras of Colossae', summary: 'Who he was.', startMs: 15_000 }, handle);
    const loud = fakeEmbedder();
    const row = await run(await claimed(seeded.recordingId), loud);
    expect(loud.calls).toEqual([['Epaphras of Colossae\n\nWho he was.']]);
    expect(row.providerMeta).toMatchObject({ embedded: 1, unchanged: before.size - 1 });
  });

  it('drops the rows of chapters that were replaced wholesale, and writes the new list', async () => {
    const seeded = await teaching();
    await run(await claimed(seeded.recordingId));

    await replaceChapters(
      seeded.recordingId,
      [{ startMs: 0, title: 'One chapter now', summary: 'Everything.', editedByAdmin: true }],
      { model: 'human' },
      handle,
    );
    const row = await run(await claimed(seeded.recordingId));

    const chapters = [...(await rowsOf(seeded.recordingId)).values()].filter((one) => one.sourceKind === 'chapter');
    expect(chapters.map((one) => one.text)).toEqual(['One chapter now\n\nEverything.']);
    expect(row.providerMeta).toMatchObject({ embedded: 1, removed: CHAPTERS.length });
  });

  it('a re-transcription replaces every segment row — the old ids are gone and the new ones are in', async () => {
    const seeded = await teaching();
    await run(await claimed(seeded.recordingId));

    const transcript = await replaceTranscript(
      { recordingId: seeded.recordingId, language: 'en', confidence: 0.95, segments: [...SEGMENTS.slice(0, 2)] },
      handle,
    );
    const newIds = (await listSegments(transcript.id, handle)).map((one) => one.id);
    await run(await claimed(seeded.recordingId));

    // The two new sentences are one window, keyed on the first of them; the old window's row — keyed
    // on an id that no longer exists — is gone.
    const segments = [...(await rowsOf(seeded.recordingId)).values()].filter((one) => one.sourceKind === 'segment');
    expect(segments.map((one) => one.sourceId)).toEqual([newIds[0]]);
    expect(segments[0]?.windowLastSegmentId).toBe(newIds[1]);
    expect(await findEmbeddingsForSources('segment', [...seeded.segmentIds], handle)).toEqual([]);
  });
});

describe('its place in the chain', () => {
  it('follows generate_questions and hands on to cross_reference', async () => {
    // After the chapters and the questions written about them, because it embeds the chapters;
    // before cross-referencing, which reads what it wrote ([3.9](docs/project/prd.md)). The
    // successor is asserted by running it below.
    expect(PIPELINE_STEPS.indexOf('embed')).toBe(PIPELINE_STEPS.indexOf('generate_questions') + 1);
    expect(PIPELINE_STEPS.indexOf('generate_questions')).toBe(
      PIPELINE_STEPS.indexOf('generate_chapters') + 1,
    );

    const seeded = await teaching();
    const generated = await run(await claimed(seeded.recordingId, 'generate_chapters'));
    expect(generated.status).toBe('succeeded');

    const ledger = await sql<{ step: string; status: string }[]>`
      select step::text as step, status::text as status from job
      where recording_id = ${seeded.recordingId} order by enqueued_at, id
    `;
    expect(ledger.map((row) => [row.step, row.status])).toEqual([
      ['generate_chapters', 'succeeded'],
      ['generate_questions', 'pending'],
    ]);

    // Run the questions step it enqueued, which hands on to embedding.
    const questions = await findUnfinishedJob(seeded.recordingId, 'generate_questions', handle);
    expect(questions).not.toBeNull();
    await sql`update job set status = 'running', started_at = now() where id = ${questions?.id as string}`;
    const asked = await run({ ...(questions as JobRow), status: 'running', startedAt: new Date() });
    expect(asked.status).toBe('succeeded');

    // Run what that enqueued, and it hands on to cross-referencing in turn.
    const pending = await findUnfinishedJob(seeded.recordingId, 'embed', handle);
    expect(pending).not.toBeNull();
    expect(pending?.correlationId).toBe(generated.correlationId);
    await sql`update job set status = 'running', started_at = now() where id = ${pending?.id as string}`;
    const row = await run({ ...(pending as JobRow), status: 'running', startedAt: new Date() });
    expect(row.status).toBe('succeeded');
    const after = await sql<{ step: string; status: string }[]>`
      select step::text as step, status::text as status from job
      where recording_id = ${seeded.recordingId} order by enqueued_at, id
    `;
    expect(after.map((one) => [one.step, one.status])).toEqual([
      ['generate_chapters', 'succeeded'],
      ['generate_questions', 'succeeded'],
      ['embed', 'succeeded'],
      ['cross_reference', 'pending'],
    ]);
    expect((await rowsOf(seeded.recordingId)).size).toBeGreaterThan(0);
  });

  it('raises the domain event cross-referencing will attach to', async () => {
    const seeded = await teaching();
    await run(await claimed(seeded.recordingId));
    const events = captured.filter((line) => line.message === DOMAIN_EVENT_MESSAGE && line['event'] === 'recording_embedded');
    expect(events).toHaveLength(1);
    expect(events[0]?.['recordingId']).toBe(seeded.recordingId);
  });
});
