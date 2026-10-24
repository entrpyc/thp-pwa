import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  createDatabase,
  deleteCrossReferencesTouching,
  enqueueJob,
  findUnfinishedJob,
  insertRecording,
  listCrossReferencesComputedFor,
  listCrossReferencesTouching,
  listOutgoingCrossReferences,
  listSegments,
  replaceChapters,
  replaceTranscript,
  runMigrations,
  setRecordingPublication,
  upsertEmbeddings,
  type DatabaseHandle,
  type JobRow,
} from '@thp/db';
import {
  CROSS_REFERENCES_PER_CHAPTER,
  PIPELINE_STEPS,
  buildPassageWindows,
  type PipelineStep,
} from '@thp/shared';
import { DOMAIN_EVENT_MESSAGE } from '@thp/shared/observability/events';
import { setLogSink, type LogLine } from '@thp/shared/observability/logger';
import {
  CROSS_REFERENCE_MIN_SIMILARITY,
  CROSS_REFERENCE_MIN_WORDS,
} from '../../src/cross-reference-recording';
import { FAKE_EMBED_MODEL, fakeEmbedder, fakeVector } from '../../src/embed';
import { fakeGenerator } from '../../src/generate';
import { createHandlers } from '../../src/handlers';
import { runJob } from '../../src/run-job';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * **The `cross_reference` step, against a real database and a real index**
 * ([3.9.1](docs/project/prd.md), [3.9.6](docs/project/prd.md); project tdd 5.7).
 *
 * **The provider is faked and nothing else is.** The fake embedder's vectors are a function of
 * the words — the same sentence in two teachings is the same vector, two different sentences are
 * two unrelated ones — which is exactly what makes a *shared sentence* a thing a test can plant.
 * Where a test needs a similarity *between* 0 and 1 — to drive the threshold and the ranking — it
 * writes a vector of its own at a chosen cosine to a planted sentence's, through the same
 * `upsertEmbeddings` the embed step uses. Nothing here reaches a provider.
 *
 * **Every test plants its own sentences**, tagged with its name: the suite shares one database and
 * one index, so a sentence reused across tests would be a full-score match into another test's
 * teachings, and a "nothing is linked" assertion would be false for a reason that has nothing to
 * do with the step.
 *
 * The properties this suite exists for: a link is written from both sides; a draft neither gives
 * nor receives; the threshold, the word floor and the per-chapter cap decide what is kept; a
 * re-run replaces exactly its own rows; and the step is where the chain ends.
 */

const databaseUrl = inject('databaseUrl');

/**
 * Forty seconds a line. The index holds **passage windows**, not sentences, and a window closes
 * once it would span more than a minute — so at forty seconds a line every sentence is a window of
 * its own, and "plant this sentence in two teachings" means what it meant when a row was a sentence.
 * A filler ("Amen.") is still no window at all, which one test below leans on.
 */
const LINE_MS = 40_000;

/** One test's sentences — all above the word floor, all unique to the tag. */
function lines(tag: string) {
  return {
    shared: `Turn with me now to the eighth chapter of Romans and read it slowly (${tag}).`,
    other: `A different sentence about something else entirely, said in more than eight words (${tag}).`,
    filler: [
      `Good morning to everybody, and a warm welcome to all of you here today (${tag}).`,
      `Before we begin, a word about the family we have been praying for this week (${tag}).`,
      `Let us open our hearts and our minds to what we are about to hear together (${tag}).`,
      `And so we come to the end of what there is to say this morning (${tag}).`,
    ] as const,
  };
}

let target: ThrowawayDatabase;
let sql: postgres.Sql;
let handle: DatabaseHandle;
let made = 0;
let captured: LogLine[] = [];
let restoreSink: () => void;

interface Seeded {
  readonly id: string;
  readonly title: string;
  readonly segmentIds: readonly string[];
  readonly texts: readonly string[];
}

/**
 * A recording with a transcript of these sentences, ten seconds apart, published unless said
 * otherwise, and — unless `embedded: false` — with a segment vector per sentence written the way
 * the embed step would write it.
 */
async function teaching(
  texts: readonly string[],
  options: { published?: boolean; chapterStarts?: readonly number[]; embedded?: boolean } = {},
): Promise<Seeded> {
  made += 1;
  const title = `Teaching ${made}`;
  const recording = await insertRecording(
    {
      originalMediaKey: `originals/xref-${made}-${Date.now().toString(36)}.mp3`,
      title,
      recordedAt: '2026-10-01',
    },
    handle,
  );
  const transcript = await replaceTranscript(
    {
      recordingId: recording.id,
      language: 'en',
      confidence: 0.95,
      segments: texts.map((text, index) => ({
        startMs: index * LINE_MS,
        endMs: (index + 1) * LINE_MS,
        text,
      })),
    },
    handle,
  );
  const segments = await listSegments(transcript.id, handle);
  const segmentIds = segments.map((one) => one.id);
  if (options.chapterStarts !== undefined) {
    await replaceChapters(
      recording.id,
      options.chapterStarts.map((startMs, index) => ({
        startMs,
        title: `Chapter ${index + 1}`,
        summary: 'A part.',
        editedByAdmin: false,
      })),
      { model: 'fake' },
      handle,
    );
  }
  if (options.embedded !== false) {
    // Written the way the embed step writes them: one row per passage window, with its extent.
    await upsertEmbeddings(
      buildPassageWindows(segments).map((window) => ({
        sourceKind: 'segment' as const,
        sourceId: window.sourceId,
        recordingId: recording.id,
        ownerUserId: null,
        text: window.text,
        vector: fakeVector(window.text),
        model: FAKE_EMBED_MODEL,
        windowFirstSegmentId: window.firstSegmentId,
        windowLastSegmentId: window.lastSegmentId,
      })),
      handle,
    );
  }
  if (options.published !== false) await setRecordingPublication(recording.id, new Date(), handle);
  return { id: recording.id, title, segmentIds, texts };
}

/**
 * A unit vector at cosine `similarity` to `anchor`: the anchor scaled, plus an unrelated direction
 * made orthogonal to it and scaled to make up the length. What lets a test say "this sentence is
 * 0.75 like that one" to an index that otherwise only knows identical and unrelated.
 */
function atSimilarity(anchor: readonly number[], similarity: number): number[] {
  const other = fakeVector(`orthogonal seed ${similarity} ${anchor[0]}`);
  const dot = other.reduce((sum, value, index) => sum + value * (anchor[index] as number), 0);
  const residual = other.map((value, index) => value - dot * (anchor[index] as number));
  const norm = Math.sqrt(residual.reduce((sum, value) => sum + value * value, 0));
  const sine = Math.sqrt(1 - similarity * similarity);
  return anchor.map((value, index) => similarity * value + (sine * (residual[index] as number)) / norm);
}

/** Overwrite one sentence's vector with one at a chosen cosine to another sentence's. */
async function setVector(seeded: Seeded, index: number, anchorText: string, similarity: number): Promise<void> {
  await upsertEmbeddings(
    [
      {
        sourceKind: 'segment',
        sourceId: seeded.segmentIds[index] as string,
        recordingId: seeded.id,
        ownerUserId: null,
        text: seeded.texts[index] as string,
        vector: atSimilarity(fakeVector(anchorText), similarity),
        model: FAKE_EMBED_MODEL,
        windowFirstSegmentId: seeded.segmentIds[index] as string,
        windowLastSegmentId: seeded.segmentIds[index] as string,
      },
    ],
    handle,
  );
}

async function claimed(recordingId: string, step: PipelineStep = 'cross_reference'): Promise<JobRow> {
  const job = await enqueueJob(
    { recordingId, step, correlationId: `xref-${made}-${Math.random().toString(36).slice(2)}` },
    handle,
  );
  await sql`update job set status = 'running', started_at = now() where id = ${job.id}`;
  return { ...job, status: 'running', startedAt: new Date() };
}

function run(job: JobRow): Promise<JobRow> {
  return runJob(
    job,
    createHandlers({
      embedder: fakeEmbedder(),
      generator: fakeGenerator({ summary: 's', description: 'd' }),
      executor: handle,
    }),
    { executor: handle },
  );
}

function eventsFor(recordingId: string): LogLine[] {
  return captured.filter(
    (line) =>
      line.message === DOMAIN_EVENT_MESSAGE &&
      line['event'] === 'recording_cross_referenced' &&
      line['recordingId'] === recordingId,
  );
}

beforeAll(async () => {
  target = await createThrowawayDatabase(databaseUrl, 'cross_reference');
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

describe('what the step links', () => {
  it('writes a shared sentence as a link from both sides, anchored to the sentence on each', async () => {
    const L = lines('both-ways');
    const a = await teaching([L.filler[0], L.shared, L.filler[1]]);
    const b = await teaching([L.filler[2], L.other, L.shared]);

    const row = await run(await claimed(a.id));
    expect(row.status).toBe('succeeded');
    expect(row.providerMeta).toMatchObject({ provider: 'pgvector', links: 1, segments: 3, asked: 3 });

    const rows = await listCrossReferencesTouching(a.id, handle);
    expect(rows).toHaveLength(2);
    for (const one of rows) {
      expect(one.computedFor).toBe(a.id);
      expect(one.basis).toBe('semantic');
      expect(one.score).toBeCloseTo(1, 4);
    }
    const forward = rows.find((one) => one.sourceRecordingId === a.id);
    const back = rows.find((one) => one.sourceRecordingId === b.id);
    expect(forward).toMatchObject({
      sourceSegmentId: a.segmentIds[1],
      targetRecordingId: b.id,
      targetSegmentId: b.segmentIds[2],
    });
    expect(back).toMatchObject({
      sourceSegmentId: b.segmentIds[2],
      targetRecordingId: a.id,
      targetSegmentId: a.segmentIds[1],
    });

    // B's page reads the link A's run found, pointing at A's moment (3.9.6).
    const outgoing = await listOutgoingCrossReferences(b.id, handle);
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]).toMatchObject({
      sourceStartMs: 2 * LINE_MS,
      sourceText: L.shared,
      targetRecordingId: a.id,
      targetStartMs: LINE_MS,
      targetText: L.shared,
      targetTitle: a.title,
      targetSeriesId: null,
    });
  });

  it('keeps nothing under the threshold and asks nothing of a sentence under the word floor', async () => {
    const L = lines('threshold');
    const a = await teaching(['Amen.', L.shared, L.filler[0]]);
    // Shares the short sentence exactly, and nothing else: identical vectors, but too few words to ask.
    await teaching(['Amen.', L.other]);
    // Two teachings each with one sentence near A's long one: one just under the floor, one over.
    const under = await teaching([L.filler[1]]);
    await setVector(under, 0, L.shared, CROSS_REFERENCE_MIN_SIMILARITY - 0.05);
    const over = await teaching([L.filler[2]]);
    await setVector(over, 0, L.shared, CROSS_REFERENCE_MIN_SIMILARITY + 0.05);

    expect('Amen.'.split(/\s+/).length).toBeLessThan(CROSS_REFERENCE_MIN_WORDS);

    const row = await run(await claimed(a.id));
    expect(row.status).toBe('succeeded');
    // Three sentences, two windows: the short one is a filler and never a window at all, so it is
    // not asked about — and would be refused by the word floor if it were.
    expect(row.providerMeta).toMatchObject({ segments: 3, windows: 2, asked: 2, links: 1 });

    const outgoing = await listOutgoingCrossReferences(a.id, handle);
    expect(outgoing.map((one) => one.targetRecordingId)).toEqual([over.id]);
    expect(outgoing[0]?.score).toBeCloseTo(CROSS_REFERENCE_MIN_SIMILARITY + 0.05, 3);
    expect(outgoing[0]?.sourceStartMs).toBe(LINE_MS);
  });

  it('keeps the three strongest of each chapter, one per other teaching', async () => {
    const L = lines('cap');
    // Two chapters: the first holds sentences 0–2, the second sentences 3–4.
    const a = await teaching([L.filler[0], L.filler[1], L.filler[2], L.other, L.shared], {
      chapterStarts: [0, 3 * LINE_MS],
    });
    const [s0, s1, s2] = L.filler;

    // B is close to two of the first chapter's sentences; only its strongest should be taken.
    const b = await teaching([`b one is a sentence of eight words long (${L.shared}).`, `b two is a sentence of eight words long (${L.shared}).`]);
    await setVector(b, 0, s0, 0.95);
    await setVector(b, 1, s1, 0.9);
    const c = await teaching([`c one is a sentence of eight words long (${L.shared}).`]);
    await setVector(c, 0, s1, 0.85);
    const d = await teaching([`d one is a sentence of eight words long (${L.shared}).`]);
    await setVector(d, 0, s2, 0.8);
    // The fourth-strongest in the first chapter: over the threshold, dropped by the cap.
    const e = await teaching([`e one is a sentence of eight words long (${L.shared}).`]);
    await setVector(e, 0, s2, 0.78);
    // The second chapter's only match — it has its own allowance.
    const f = await teaching([`f one is a sentence of eight words long (${L.shared}).`]);
    await setVector(f, 0, L.shared, 0.9);

    const row = await run(await claimed(a.id));
    expect(row.status).toBe('succeeded');
    expect(row.providerMeta).toMatchObject({ chapters: 2, links: CROSS_REFERENCES_PER_CHAPTER + 1 });

    const outgoing = await listOutgoingCrossReferences(a.id, handle);
    expect(outgoing.map((one) => [one.targetRecordingId, one.sourceStartMs])).toEqual([
      [b.id, 0],
      [f.id, 4 * LINE_MS],
      [c.id, LINE_MS],
      [d.id, 2 * LINE_MS],
    ]);
    expect(outgoing.map((one) => one.targetRecordingId)).not.toContain(e.id);
    // Both directions for every one of them.
    expect(await listCrossReferencesComputedFor([a.id], handle)).toHaveLength(2 * 4);
  });

  it('treats a teaching with no chapters as one chapter', async () => {
    const L = lines('chapterless');
    const a = await teaching([...L.filler]);
    for (const text of a.texts) {
      // One other teaching per sentence of A, each sharing that sentence exactly.
      await teaching([text, L.other]);
    }
    const row = await run(await claimed(a.id));
    expect(row.providerMeta).toMatchObject({ chapters: 0, links: CROSS_REFERENCES_PER_CHAPTER });
    expect(await listOutgoingCrossReferences(a.id, handle)).toHaveLength(CROSS_REFERENCES_PER_CHAPTER);
  });

  it('gives a draft nothing and offers it nothing, until it is published', async () => {
    const L = lines('draft');
    const a = await teaching([L.shared, L.filler[0]]);
    const draft = await teaching([L.filler[1], L.shared], { published: false });

    // The published teaching's run does not find the draft.
    await run(await claimed(a.id));
    expect(await listCrossReferencesTouching(a.id, handle)).toEqual([]);

    // The draft's own run writes nothing, and says why on its row.
    const skipped = await run(await claimed(draft.id));
    expect(skipped.status).toBe('succeeded');
    expect(skipped.providerMeta).toMatchObject({ skipped: 'unpublished', links: 0 });
    expect(await listCrossReferencesTouching(draft.id, handle)).toEqual([]);
    // No event for it: nothing a member can see changed.
    expect(eventsFor(draft.id)).toHaveLength(0);

    // Published, the same run links both ways.
    await setRecordingPublication(draft.id, new Date(), handle);
    await run(await claimed(draft.id));
    expect(await listCrossReferencesTouching(draft.id, handle)).toHaveLength(2);
    expect(await listOutgoingCrossReferences(a.id, handle)).toHaveLength(1);
    expect(eventsFor(draft.id)).toHaveLength(1);

    // Unpublishing removes every row touching the teaching, on either end — what the publication
    // route calls in the transaction that clears the timestamp.
    await setRecordingPublication(draft.id, null, handle);
    expect(await deleteCrossReferencesTouching(draft.id, handle)).toBe(2);
    expect(await listCrossReferencesTouching(a.id, handle)).toEqual([]);
  });

  it('replaces its own rows on a re-run and leaves the other teaching’s run alone', async () => {
    const L = lines('replace');
    const a = await teaching([L.shared, L.filler[0]]);
    const b = await teaching([L.filler[1], L.shared]);

    await run(await claimed(a.id));
    expect(await listCrossReferencesTouching(a.id, handle)).toHaveLength(2);

    // B's run finds the same pair: a second opinion, two more rows, under B's name.
    await run(await claimed(b.id));
    expect(await listCrossReferencesTouching(a.id, handle)).toHaveLength(4);
    expect(await listCrossReferencesComputedFor([a.id], handle)).toHaveLength(2);
    expect(await listCrossReferencesComputedFor([b.id], handle)).toHaveLength(2);

    // A again — at-least-once dispatch, or an admin's press: one set of A's rows, B's untouched.
    await run(await claimed(a.id));
    expect(await listCrossReferencesTouching(a.id, handle)).toHaveLength(4);
    expect(await listCrossReferencesComputedFor([a.id], handle)).toHaveLength(2);
    expect(await listCrossReferencesComputedFor([b.id], handle)).toHaveLength(2);

    // The read dedupes the pair; nothing here does, and it says so by answering both.
    expect(await listOutgoingCrossReferences(a.id, handle)).toHaveLength(2);
  });

  it('raises the domain event, naming the teaching', async () => {
    const L = lines('event');
    const a = await teaching([L.shared]);
    await teaching([L.shared]);
    await run(await claimed(a.id));
    expect(eventsFor(a.id)).toHaveLength(1);
  });
});

describe('its place in the chain', () => {
  it('is the last step, enqueued when embed succeeds, and enqueues nothing itself', async () => {
    expect(PIPELINE_STEPS[PIPELINE_STEPS.length - 1]).toBe('cross_reference');
    expect(PIPELINE_STEPS.indexOf('cross_reference')).toBe(PIPELINE_STEPS.indexOf('embed') + 1);

    const L = lines('chain');
    // A's vectors come from the real embed step with the fake embedder; B's were written directly.
    const a = await teaching([L.filler[0], L.shared], { embedded: false });
    const b = await teaching([L.shared, L.filler[1]]);

    const embedded = await run(await claimed(a.id, 'embed'));
    expect(embedded.status).toBe('succeeded');

    const ledger = async () =>
      (await sql<{ step: string; status: string; correlation_id: string }[]>`
        select step::text as step, status::text as status, correlation_id from job
        where recording_id = ${a.id} order by enqueued_at, id
      `) as unknown as { step: string; status: string; correlation_id: string }[];

    expect((await ledger()).map((row) => [row.step, row.status])).toEqual([
      ['embed', 'succeeded'],
      ['cross_reference', 'pending'],
    ]);

    const pending = await findUnfinishedJob(a.id, 'cross_reference', handle);
    expect(pending?.correlationId).toBe(embedded.correlationId);
    await sql`update job set status = 'running', started_at = now() where id = ${pending?.id as string}`;
    const row = await run({ ...(pending as JobRow), status: 'running', startedAt: new Date() });
    expect(row.status).toBe('succeeded');

    // The chain stops here without treating that as a failure, and the link is there.
    expect((await ledger()).map((row) => [row.step, row.status])).toEqual([
      ['embed', 'succeeded'],
      ['cross_reference', 'succeeded'],
    ]);
    expect(await listOutgoingCrossReferences(b.id, handle)).toHaveLength(1);
  });
});
