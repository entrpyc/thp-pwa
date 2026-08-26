import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  createDatabase,
  enqueueJob,
  findRecordingById,
  findSummaryByRecording,
  insertRecording,
  listPendingReviews,
  replaceTranscript,
  runMigrations,
  type DatabaseHandle,
  type JobRow,
} from '@thp/db';
import type { BibleSource } from '@thp/bible';
import { REVIEW_KINDS, type ReviewKind, type ReviewProvenance } from '@thp/shared';
import { DOMAIN_EVENT_MESSAGE } from '@thp/shared/observability/events';
import { setLogSink, type LogLine } from '@thp/shared/observability/logger';
import { GenerationError, fakeGenerator, type Generator } from '../../src/generate';
import { createHandlers } from '../../src/handlers';
import { runJob } from '../../src/run-job';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * The `generate_draft` handler, against a real database.
 *
 * **The provider is the only thing faked**, and it is faked by configuration rather than by a mock:
 * a `Generator` is handed in exactly as the loop is handed a handler registry. Everything else is
 * real, because everything else is what the criteria are about — two rows that genuinely survive
 * being written twice, a provenance that genuinely reads back, and a failure that genuinely leaves
 * the ledger saying why.
 *
 * The property this suite exists for above all others is the last one: **nothing it writes is
 * member-visible.** A generation that quietly created a summary or filled in the description would
 * be the review gate not existing.
 */

const databaseUrl = inject('databaseUrl');

const DRAFT = {
  summary: 'The teaching stays with the second chapter of the letter throughout.',
  description: 'A close reading of the second chapter.',
  // The book comes as words, because that is what a model has. One out-of-canon proposal and one
  // repeat, so a run's ordinary answer exercises the dropping and the collapsing.
  citations: [
    { book: 'Romans', chapter: 8, verseStart: 1, verseEnd: 4 },
    { book: 'John', chapter: 3, verseStart: 16, verseEnd: 16 },
    { book: 'Romans', chapter: 8, verseStart: 1, verseEnd: 4 },
    { book: 'Hezekiah', chapter: 2, verseStart: 1, verseEnd: 1 },
  ],
};

let target: ThrowawayDatabase;
let sql: postgres.Sql;
let handle: DatabaseHandle;
let recordings = 0;
let captured: LogLine[] = [];
let restoreSink: () => void;

/** A recording with a transcript behind it, and a claimed `generate_draft` job against it. */
async function claimedJob(
  options: { transcript?: boolean; payload?: unknown; segments?: string[] } = {},
): Promise<JobRow> {
  recordings += 1;
  const recording = await insertRecording(
    {
      originalMediaKey: `originals/generate-${recordings}-${Date.now().toString(36)}.mp3`,
      title: `Teaching ${recordings}`,
      recordedAt: '2026-08-16',
    },
    handle,
  );

  if (options.transcript !== false) {
    const texts = options.segments ?? [
      'Good morning, and welcome to this teaching.',
      'We are picking up in the second chapter.',
    ];
    await replaceTranscript(
      {
        recordingId: recording.id,
        language: 'en',
        confidence: 0.94,
        segments: texts.map((text, index) => ({
          startMs: index * 4000,
          endMs: (index + 1) * 4000,
          text,
        })),
      },
      handle,
    );
  }

  const job = await enqueueJob(
    {
      recordingId: recording.id,
      step: 'generate_draft',
      correlationId: `generate-${recordings}-correlation`,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    },
    handle,
  );
  await sql`update job set status = 'running', started_at = now() where id = ${job.id}`;
  return { ...job, status: 'running', startedAt: new Date() };
}

/** Every review item for a recording, in the order they were written. */
async function items(recordingId: string): Promise<
  { id: string; kind: ReviewKind; status: string; fields: unknown; provenance: unknown }[]
> {
  return (await sql`
    select id, kind::text as kind, status::text as status, fields, provenance
    from review_item where recording_id = ${recordingId} order by created_at, kind
  `) as unknown as {
    id: string;
    kind: ReviewKind;
    status: string;
    fields: unknown;
    provenance: unknown;
  }[];
}

/**
 * A verse source that answers every citation and says which call it was.
 *
 * Handed in exactly as the generator is, so this suite reaches no Bible API either — and built
 * fresh per run, so "how many calls did this job make" is a question about one job.
 */
function countingBibleSource(): BibleSource {
  let calls = 0;
  return {
    name: 'counting',
    async readPassage(citation) {
      calls += 1;
      const verses = [];
      for (let number = citation.verseStart; number <= citation.verseEnd; number += 1) {
        verses.push({ number, text: `Verse ${number} as the source has it.` });
      }
      return { verses, requestId: `call-${calls}` };
    },
  };
}

function run(
  job: JobRow,
  generator: Generator = fakeGenerator(DRAFT),
  bibleSource: BibleSource = countingBibleSource(),
): Promise<JobRow> {
  return runJob(job, createHandlers({ generator, bibleSource, executor: handle }), {
    executor: handle,
  });
}

beforeAll(async () => {
  target = await createThrowawayDatabase(databaseUrl, 'generate_draft');
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

describe('one call, two drafts', () => {
  it('writes one row per kind, carrying what the model wrote', async () => {
    const job = await claimedJob();

    const row = await run(job);
    expect(row.status).toBe('succeeded');

    const written = await items(job.recordingId);
    expect(written.map((one) => one.kind).sort()).toEqual([...REVIEW_KINDS].sort());
    expect(written.every((one) => one.status === 'draft')).toBe(true);

    const summary = written.find((one) => one.kind === 'summary');
    const metadata = written.find((one) => one.kind === 'recording_metadata');
    // Keyed by field name, which is what makes the review form a form over one row rather than a
    // column per field per artefact.
    expect(summary?.fields).toEqual({ summary: DRAFT.summary });
    expect(metadata?.fields).toEqual({ description: DRAFT.description });

    // 1.3.1 — the same run produced the citations, as structured entries rather than as prose,
    // with the book stored as the canon's identity rather than as the words the model wrote.
    const scripture = written.find((one) => one.kind === 'scripture');
    expect(scripture?.fields).toEqual({
      citations: [
        { book: 'john', chapter: 3, verseStart: 16, verseEnd: 16 },
        { book: 'romans', chapter: 8, verseStart: 1, verseEnd: 4 },
      ],
    });
  });

  // 1.3.3 / 1.3.4 — what the model proposed and could not be stored is a number on the run that
  // proposed it, so a prompt starting to hallucinate books is visible rather than quiet.
  it('records how much of the answer was not usable on the job that produced it', async () => {
    const job = await claimedJob();

    const row = await run(job);

    expect(row.providerMeta).toMatchObject({ citationsDropped: 1, citationsDuplicated: 1 });
    expect(captured.filter((line) => line.message === 'generate_draft.citations_discarded')).toEqual(
      [expect.objectContaining({ dropped: 1, duplicates: 1 })],
    );
  });

  // 1.3.5 — the item still arrives, so an admin confirms "none" rather than the draft never
  // showing up, and so Task 2.2's add control has something to act on.
  it('writes a scripture draft holding an empty list when the machine finds none', async () => {
    const job = await claimedJob();

    await run(job, fakeGenerator({ ...DRAFT, citations: [] }));

    const scripture = (await items(job.recordingId)).find((one) => one.kind === 'scripture');
    expect(scripture).toBeDefined();
    expect(scripture?.status).toBe('draft');
    expect(scripture?.fields).toEqual({ citations: [] });
  });

  // 1.3.2 — the structure was required, so an answer that is not one fails the step and leaves
  // nothing behind. Nothing partial: not the summary either, which came back perfectly well.
  it('fails the job and writes nothing when a list-shaped field comes back as prose', async () => {
    const job = await claimedJob();
    const prose: Generator = {
      name: 'prose',
      generate: async () => ({
        drafts: {
          summary: DRAFT.summary,
          recording_metadata: DRAFT.description,
          scripture: 'Romans 8:1-4 and John 3:16',
        },
        promptVersion: 'draft-1',
        spend: {
          model: 'prose',
          modelVersion: 'prose-1',
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          requestId: 'prose-1',
        },
      }),
    };

    const row = await run(job, prose);

    expect(row.status).toBe('failed');
    expect(row.error).toContain('list of citations');
    expect(await items(job.recordingId)).toHaveLength(0);
  });

  it('makes exactly one provider call for both artefacts', async () => {
    const model = fakeGenerator(DRAFT);
    await run(await claimedJob(), model);

    // The cost and consistency decision, at the seam it is actually taken: one request carrying the
    // transcript, not one per artefact.
    expect(model.requests).toHaveLength(1);
    expect([...(model.requests[0]?.kinds ?? [])].sort()).toEqual([...REVIEW_KINDS].sort());
  });

  it('hands the provider the transcript joined from the segment rows, in playback order', async () => {
    const model = fakeGenerator(DRAFT);
    const job = await claimedJob({ segments: ['First sentence.', 'Second sentence.', 'Third.'] });

    await run(job, model);

    // There is no concatenated copy to read — Story 2 Ticket 03 deliberately did not write one, so
    // the join is what the handler does and the order is the one `listSegments` decided.
    expect(model.requests[0]?.transcript).toBe('First sentence. Second sentence. Third.');
    expect(model.requests[0]?.title).toBe(`Teaching ${recordings}`);
  });

  it('records the model, its version and the prompt version on every row', async () => {
    const job = await claimedJob();
    await run(job);

    for (const one of await items(job.recordingId)) {
      const provenance = one.provenance as ReviewProvenance;
      // docs/project/prd.md 4.17.5: which model, which version, which prompt version — present and
      // non-empty on both rows, or an admin comparing two drafts has nothing to compare.
      expect(provenance.model).not.toBe('');
      expect(provenance.modelVersion).not.toBe('');
      expect(provenance.promptVersion).not.toBe('');
    }
  });

  it('records per field that it was AI-suggested and that no admin has touched it', async () => {
    const job = await claimedJob();
    await run(job);

    const written = await items(job.recordingId);
    const summary = written.find((one) => one.kind === 'summary')?.provenance as ReviewProvenance;
    const metadata = written.find((one) => one.kind === 'recording_metadata')
      ?.provenance as ReviewProvenance;

    expect(summary.fields['summary']).toEqual({ aiSuggested: true, editedByAdmin: false });
    expect(metadata.fields['description']).toEqual({ aiSuggested: true, editedByAdmin: false });
    expect(summary.steeringPrompt).toBeNull();
  });

  it('records what the job cost, in the shape transcribe already uses', async () => {
    const job = await claimedJob();
    const row = await run(job);

    // docs/project/prd.md §7 wants spend measured rather than estimated, per job.
    expect(row.providerMeta).toMatchObject({
      model: 'fake',
      modelVersion: 'fake-1',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    expect(row.providerMeta).toHaveProperty('requestId');
    expect(row.providerMeta).toHaveProperty('promptVersion');
    // The last stub is gone, so no succeeded row in this ledger marks itself as one.
    expect(row.providerMeta).not.toHaveProperty('stub');
  });
});

describe('nothing it writes is member-visible', () => {
  it('creates no summary, leaves the description alone and leaves published_at null', async () => {
    const job = await claimedJob();
    await run(job);

    // The whole of docs/project/prd.md 3.21.2.2 and 3.6.2: generation proposes, and an admin is
    // the only thing that makes anything visible. Two rows waiting, and not one member-readable
    // byte written.
    expect(await findSummaryByRecording(job.recordingId, handle)).toBeNull();
    const recording = await findRecordingById(job.recordingId, handle);
    expect(recording?.description).toBeNull();
    expect(recording?.publishedAt).toBeNull();
  });

  // 1.3.6 — the citations are a *proposal*. No reference row exists until an admin approves the
  // list, so there is nothing for the member surface to read however the recording is published.
  it('writes no scripture reference, so nothing a member can reach exists yet', async () => {
    const job = await claimedJob();
    await run(job);

    const rows = await sql`
      select count(*)::int as count from scripture_reference where recording_id = ${job.recordingId}
    `;
    expect(rows[0]?.['count']).toBe(0);
  });
});

describe('running it twice', () => {
  it('leaves one draft per kind, not two', async () => {
    const job = await claimedJob();

    // Dispatch is at-least-once: the startup sweep and the panel's re-run both call this again on
    // the same recording, so the write has to be a replace rather than an append.
    await run(job);
    await run(job);

    const written = await items(job.recordingId);
    expect(written).toHaveLength(REVIEW_KINDS.length);
  });

  it('never touches a closed item, so the audit trail survives a regeneration', async () => {
    const job = await claimedJob();
    await run(job);

    const [first] = await items(job.recordingId);
    const closedId = first?.id ?? '';
    await sql`update review_item set status = 'discarded' where id = ${closedId}`;

    await run(job);

    const written = await items(job.recordingId);
    // The closed one stays, and a fresh draft of that kind is written beside it — which is what
    // makes "the row remains the record of what was rejected" true rather than intended.
    expect(written.filter((one) => one.status === 'discarded')).toHaveLength(1);
    expect(written.filter((one) => one.status === 'draft')).toHaveLength(REVIEW_KINDS.length);
    expect(written.some((one) => one.id === closedId)).toBe(true);
  });
});

describe('what a payload asks for', () => {
  it('generates only the kind it names, and leaves the other kind’s draft alone', async () => {
    const first = await claimedJob();
    await run(first);
    const before = await items(first.recordingId);
    const untouched = before.find((one) => one.kind === 'recording_metadata');

    // A steered regeneration of one kind — the shape the regenerate route enqueues.
    const second = await enqueueJob(
      {
        recordingId: first.recordingId,
        step: 'generate_draft',
        correlationId: 'a-regeneration',
        payload: { kinds: ['summary'], prompt: 'Say more about the second half.' },
      },
      handle,
    );
    const model = fakeGenerator(DRAFT);
    await run({ ...second, status: 'running' }, model);

    expect(model.requests[0]?.kinds).toEqual(['summary']);
    expect(model.requests[0]?.steeringPrompt).toBe('Say more about the second half.');

    const after = await items(first.recordingId);
    expect(after.filter((one) => one.kind === 'summary')).toHaveLength(1);
    // The other kind's draft is the same row it was: a regeneration of one artefact is not a
    // regeneration of the other.
    expect(after.find((one) => one.kind === 'recording_metadata')?.id).toBe(untouched?.id);
  });

  it('records the steering sentence on the new item, so an admin can see what they asked for', async () => {
    const job = await claimedJob({
      payload: { kinds: ['summary'], prompt: 'It missed the point about the second half.' },
    });

    await run(job);

    const [written] = await items(job.recordingId);
    expect((written?.provenance as ReviewProvenance).steeringPrompt).toBe(
      'It missed the point about the second half.',
    );
  });

  // 2.3.2 — an admin asking for the scripture again steers the call that produces it, and the
  // replacement draft says what they steered it with.
  it('carries a scripture-only steer to the provider and records it on the replacement draft', async () => {
    const steer = 'It missed the passage the whole teaching was built on.';
    const first = await claimedJob();
    await run(first);
    const summaryBefore = (await items(first.recordingId)).find((one) => one.kind === 'summary');

    const again = await enqueueJob(
      {
        recordingId: first.recordingId,
        step: 'generate_draft',
        correlationId: 'scripture-again',
        payload: { kinds: ['scripture'], prompt: steer },
      },
      handle,
    );
    const model = fakeGenerator(DRAFT);
    await run({ ...again, status: 'running' }, model);

    // The sentence reaches the provider call, in the same request the transcript does.
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.kinds).toEqual(['scripture']);
    expect(model.requests[0]?.steeringPrompt).toBe(steer);

    const after = await items(first.recordingId);
    const scripture = after.find((one) => one.kind === 'scripture');
    expect((scripture?.provenance as ReviewProvenance).steeringPrompt).toBe(steer);
    // And the summary is the row it was: asking for scripture again is not asking for the summary.
    expect(after.find((one) => one.kind === 'summary')?.id).toBe(summaryBefore?.id);
  });

  it('generates both kinds when there is no payload, which is every chained job', async () => {
    const job = await claimedJob();
    await run(job);
    expect(await items(job.recordingId)).toHaveLength(REVIEW_KINDS.length);
  });
});

describe('what it refuses to generate from', () => {
  it('fails the job naming the missing transcript rather than drafting from nothing', async () => {
    const job = await claimedJob({ transcript: false });

    const row = await run(job);

    expect(row.status).toBe('failed');
    expect(row.error).toContain('no transcript');
    expect(await items(job.recordingId)).toHaveLength(0);
  });

  it('fails the job with the provider’s reason when the provider refuses', async () => {
    const job = await claimedJob();
    const refusing: Generator = {
      name: 'refusing',
      generate: () => Promise.reject(new GenerationError('the model answered without calling the tool')),
    };

    const row = await run(job, refusing);

    // The same failure shape a bad ASR response already has: readable on /admin/pipeline with its
    // reason, and re-runnable from there.
    expect(row.status).toBe('failed');
    expect(row.error).toContain('without calling the tool');
    expect(await items(job.recordingId)).toHaveLength(0);
  });

  // 1.3.8 — a provider that never answers is the same event as one that refuses: the job fails
  // with a reason an operator reads off the panel, and no partial draft is left behind.
  it('fails the job with the provider’s reason when the provider times out', async () => {
    const job = await claimedJob();
    const silent: Generator = {
      name: 'silent',
      generate: () =>
        Promise.reject(new GenerationError('the generation provider did not answer within 10 minutes')),
    };

    const row = await run(job, silent);

    expect(row.status).toBe('failed');
    expect(row.error).toContain('did not answer');
    expect(await items(job.recordingId)).toHaveLength(0);
  });
});

describe('what it says happened', () => {
  it('puts both drafts in the queue read, which is one query over one column', async () => {
    const job = await claimedJob();
    await run(job);

    const pending = (await listPendingReviews(handle)).filter(
      (one) => one.recordingId === job.recordingId,
    );
    expect(pending.map((one) => one.kind).sort()).toEqual([...REVIEW_KINDS].sort());
    expect(pending[0]?.recordingTitle).toBe(`Teaching ${recordings}`);
  });

  it('emits a domain event nothing subscribes to, and logs it', async () => {
    const job = await claimedJob();
    await run(job);

    // core-listening scope tdd § Extension points: §3.17's notifications fan
    // out from this exact event. Nothing consumes it, and no notification row exists — the only
    // sink is the logger, and this is what makes the seam real rather than described.
    const events = captured.filter((line) => line.message === DOMAIN_EVENT_MESSAGE);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'draft_generated',
      recordingId: job.recordingId,
      correlationId: job.correlationId,
    });
    expect([...((events[0]?.['kinds'] as ReviewKind[]) ?? [])].sort()).toEqual(
      [...REVIEW_KINDS].sort(),
    );
  });
});

/**
 * **The passage is held before an admin opens the item**
 * (scope plan 3.2.3–
 * scope plan 3.2.5).
 *
 * The source is handed in exactly as the generator is, so nothing here reaches a Bible API — and
 * the cache is the real table, because the whole of 3.2.3 is that a row is there afterwards.
 */
describe('the verses of what it drafted', () => {
  /** Every verse held for a teaching's chapters, whatever translation the run was configured with. */
  async function heldVerses(): Promise<{ book: string; chapter: number; verse: number; text: string }[]> {
    return (await sql`
      select book, chapter, verse, text from verse_text order by book, chapter, verse
    `) as unknown as { book: string; chapter: number; verse: number; text: string }[];
  }

  beforeEach(async () => {
    await sql`delete from verse_text`;
  });

  it('resolves every citation it produced, so the text is held before the item is opened', async () => {
    const job = await claimedJob();

    const row = await run(job);
    expect(row.status).toBe('succeeded');

    // The two that survived the canon check, and every verse of each of them.
    const held = await heldVerses();
    expect(held.filter((one) => one.book === 'john' && one.chapter === 3).map((one) => one.verse)).toEqual([16]);
    expect(held.filter((one) => one.book === 'romans' && one.chapter === 8).map((one) => one.verse)).toEqual([1, 2, 3, 4]);
    expect(held.every((one) => one.text.trim() !== '')).toBe(true);

    // And nothing was held for the proposal that was dropped, because it is not a citation.
    expect(held.some((one) => one.book === 'hezekiah')).toBe(false);
  });

  // 3.2.4 — the deliberate exception to the halt-on-failure rule. Verse text is a convenience on
  // top of the artefact, and the artefact is the citation.
  it('succeeds with the citations in place when the verse source fails', async () => {
    const job = await claimedJob();

    const row = await run(job, undefined, {
      name: 'down',
      readPassage: async () => {
        throw new Error('the verse source is unreachable');
      },
    });

    expect(row.status).toBe('succeeded');
    const scripture = (await items(job.recordingId)).find((one) => one.kind === 'scripture');
    expect(scripture?.fields).toEqual({
      citations: [
        { book: 'john', chapter: 3, verseStart: 16, verseEnd: 16 },
        { book: 'romans', chapter: 8, verseStart: 1, verseEnd: 4 },
      ],
    });
    // The reference is marked as having no text yet by there being none — which is the same state
    // the review form and the member surface already render a quiet line for.
    expect(await heldVerses()).toEqual([]);
  });

  it('succeeds when the source simply has no text for the passage', async () => {
    const job = await claimedJob();

    const row = await run(job, undefined, {
      name: 'silent',
      readPassage: async () => ({ verses: [], requestId: null }),
    });

    expect(row.status).toBe('succeeded');
    expect(await heldVerses()).toEqual([]);
    expect(row.providerMeta).toMatchObject({ versesFetched: 0, versesHeld: 0 });
  });

  // 3.2.5 — what the lookups cost, on the job that caused them. A free source spends nothing and
  // is recorded as spending nothing; what is worth counting is the calls it did not have to make.
  it('records how many verses were fetched, how many were held, and the source’s own call id', async () => {
    const first = await claimedJob();
    const firstRow = await run(first);

    expect(firstRow.providerMeta).toMatchObject({
      versesFetched: 5,
      versesHeld: 0,
      verseSourceRequestId: expect.stringContaining('call-'),
    });

    // A second teaching citing the same passages: every verse is already held, so nothing is
    // fetched and there is no call to identify.
    const second = await claimedJob();
    const secondRow = await run(second);

    expect(secondRow.providerMeta).toMatchObject({
      versesFetched: 0,
      versesHeld: 5,
      verseSourceRequestId: null,
    });
  });
});
