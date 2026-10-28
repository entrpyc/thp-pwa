import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  createDatabase,
  enqueueJob,
  findRecordingQuestion,
  insertGeneratedQuestions,
  insertRecording,
  listChapterQuestionsForRecording,
  listChapters,
  publishSummary,
  replaceChapters,
  replaceTranscript,
  runMigrations,
  setChapterQuestion,
  type DatabaseHandle,
  type JobRow,
} from '@thp/db';
import { MAX_FLOW_QUESTION_LENGTH } from '@thp/shared';
import { DOMAIN_EVENT_MESSAGE } from '@thp/shared/observability/events';
import { setLogSink, type LogLine } from '@thp/shared/observability/logger';
import {
  GenerationError,
  fakeGenerator,
  fakeReflectionFor,
  type Generator,
  type ReflectionRequest,
} from '../../src/generate';
import { createHandlers } from '../../src/handlers';
import { runJob } from '../../src/run-job';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * **The `generate_questions` step, against a real database** ([3.14.4](docs/project/prd.md),
 * [3.14.12](docs/project/prd.md)).
 *
 * The provider is the only thing faked, and by configuration — a `Generator` is handed in exactly
 * as the loop is handed a handler registry. The property this suite exists for above all others is
 * 3.14.12's: **the step fills gaps and discards nothing.** A question an admin wrote survives every
 * run; a chapter with no question gets one; a run with nothing to do spends nothing.
 */

const databaseUrl = inject('databaseUrl');
const MINUTE = 60_000;
const CHAPTERS_BY = { model: 'fake', modelVersion: 'fake-1', promptVersion: 'chapters-1' };
const SCRIPT = { summary: 'A summary.', description: 'A description.' };

let target: ThrowawayDatabase;
let sql: postgres.Sql;
let handle: DatabaseHandle;
let made = 0;
let captured: LogLine[] = [];
let restoreSink: () => void;

interface Seeded {
  readonly recordingId: string;
  readonly chapterIds: readonly string[];
}

/** A recording with a transcript, `chapters` chapters, and a claimed `generate_questions` job. */
async function seeded(options: { chapters?: number; transcript?: boolean; summary?: string } = {}): Promise<Seeded & { job: JobRow }> {
  made += 1;
  const recording = await insertRecording(
    {
      originalMediaKey: `originals/questions-${made}-${Date.now().toString(36)}.mp3`,
      title: `Teaching ${made}`,
      recordedAt: '2026-08-16',
    },
    handle,
  );
  if (options.transcript !== false) {
    await replaceTranscript(
      {
        recordingId: recording.id,
        language: 'en',
        confidence: 0.95,
        segments: Array.from({ length: 6 }, (_unused, index) => ({
          startMs: index * 10 * MINUTE,
          endMs: (index + 1) * 10 * MINUTE,
          text: `Line ${index + 1} of the teaching.`,
        })),
      },
      handle,
    );
  }
  if (options.summary !== undefined) await publishSummary(recording.id, options.summary, handle);
  const count = options.chapters ?? 3;
  const chapters = await replaceChapters(
    recording.id,
    Array.from({ length: count }, (_unused, index) => ({
      startMs: index * 20 * MINUTE,
      title: `Part ${index + 1}`,
      summary: `What part ${index + 1} teaches.`,
    })),
    CHAPTERS_BY,
    handle,
  );
  return { recordingId: recording.id, chapterIds: chapters.map((one) => one.id), job: await claim(recording.id) };
}

async function claim(recordingId: string): Promise<JobRow> {
  const job = await enqueueJob(
    { recordingId, step: 'generate_questions', correlationId: `questions-${made}-${Date.now()}` },
    handle,
  );
  await sql`update job set status = 'running', started_at = now() where id = ${job.id}`;
  return { ...job, status: 'running', startedAt: new Date() };
}

function run(job: JobRow, generator: Generator = fakeGenerator(SCRIPT)): Promise<JobRow> {
  return runJob(job, createHandlers({ generator, executor: handle }), { executor: handle });
}

beforeAll(async () => {
  target = await createThrowawayDatabase(databaseUrl, 'generate_questions');
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

// =================================================================================================

describe('one question per chapter (3.14.4)', () => {
  it('writes a question on every chapter, from the chapter’s title and summary, and records the spend', async () => {
    const model = fakeGenerator(SCRIPT);
    const { recordingId, chapterIds, job } = await seeded();
    const row = await run(job, model);
    expect(row.status).toBe('succeeded');

    const written = await listChapterQuestionsForRecording(recordingId, handle);
    expect([...written.keys()].sort()).toEqual([...chapterIds].sort());
    expect(written.get(chapterIds[0]!)?.text).toBe(fakeReflectionFor('Part 1'));
    expect(written.get(chapterIds[0]!)?.editedByAdmin).toBe(false);
    // 4.17.5 — which model, which version, which prompt.
    expect(written.get(chapterIds[0]!)?.generatedBy).toMatchObject({ model: 'fake', promptVersion: 'reflections-1' });

    // What the model was handed: titles and summaries under the chapter ids, never a transcript.
    const asked = model.reflectionRequests[0] as ReflectionRequest;
    expect(asked.title).toBe(`Teaching ${made}`);
    expect(asked.subjects.map((one) => one.key)).toEqual(chapterIds);
    expect(asked.subjects[1]).toMatchObject({ title: 'Part 2', summary: 'What part 2 teaches.' });

    expect(row.providerMeta).toMatchObject({ provider: 'fake', questionsAsked: 3, questionsWritten: 3, wholeTeaching: false });
    expect(captured.some((line) => line.message === DOMAIN_EVENT_MESSAGE && line['event'] === 'questions_generated')).toBe(true);
  });

  it('fills only the gaps: a question already there — an admin’s or a model’s — is kept (3.14.12)', async () => {
    const { recordingId, chapterIds, job } = await seeded();
    await setChapterQuestion(chapterIds[0]!, 'What the admin asked.', handle);
    await insertGeneratedQuestions(
      [{ scope: 'chapter', chapterId: chapterIds[1]!, text: 'What an earlier run asked.', generatedBy: CHAPTERS_BY }],
      handle,
    );

    const model = fakeGenerator(SCRIPT);
    const row = await run(job, model);
    expect(row.status).toBe('succeeded');
    expect(model.reflectionRequests[0]?.subjects.map((one) => one.key)).toEqual([chapterIds[2]]);

    const after = await listChapterQuestionsForRecording(recordingId, handle);
    expect(after.get(chapterIds[0]!)?.text).toBe('What the admin asked.');
    expect(after.get(chapterIds[1]!)?.text).toBe('What an earlier run asked.');
    expect(after.get(chapterIds[2]!)?.text).toBe(fakeReflectionFor('Part 3'));
  });

  it('runs twice and leaves one question per chapter, spending nothing the second time', async () => {
    const { recordingId, job } = await seeded();
    await run(job);
    const model = fakeGenerator(SCRIPT);
    const again = await run(await claim(recordingId), model);
    expect(again.status).toBe('succeeded');
    expect(model.reflectionRequests).toEqual([]);
    expect(again.providerMeta).toBeNull();
    expect((await listChapterQuestionsForRecording(recordingId, handle)).size).toBe(3);
    expect(captured.some((line) => line.message === 'generate_questions.nothing_missing')).toBe(true);
  });

  it('clips a question the model wrote past the ceiling rather than refusing it', async () => {
    const { recordingId, chapterIds, job } = await seeded({ chapters: 2 });
    const verbose: Generator = {
      name: 'verbose',
      generate: () => Promise.reject(new GenerationError('not asked for here')),
      segmentChapters: () => Promise.reject(new GenerationError('not asked for here')),
      writeReflections: async (request) => ({
        reflections: request.subjects.map((one) => ({ key: one.key, question: 'x'.repeat(MAX_FLOW_QUESTION_LENGTH + 50) })),
        promptVersion: 'reflections-1',
        spend: { model: 'v', modelVersion: 'v', inputTokens: 1, outputTokens: 1, costUsd: 0, requestId: 'r' },
      }),
    };
    expect((await run(job, verbose)).status).toBe('succeeded');
    const written = await listChapterQuestionsForRecording(recordingId, handle);
    expect(written.get(chapterIds[0]!)?.text.length).toBe(MAX_FLOW_QUESTION_LENGTH);
  });
});

describe('a chapterless teaching (3.14.3)', () => {
  it('gets one question for the whole teaching, from its summary', async () => {
    const { recordingId, job } = await seeded({ chapters: 0, summary: 'The whole teaching, summarised.' });
    const model = fakeGenerator(SCRIPT);
    const row = await run(job, model);
    expect(row.status).toBe('succeeded');
    expect(model.reflectionRequests[0]?.subjects).toEqual([
      { key: 'teaching', title: `Teaching ${made}`, summary: 'The whole teaching, summarised.' },
    ]);
    expect((await findRecordingQuestion(recordingId, handle))?.text).toBe(fakeReflectionFor(`Teaching ${made}`));
    expect(row.providerMeta).toMatchObject({ wholeTeaching: true, questionsWritten: 1 });
  });

  it('falls back to the opening of the transcript when there is no summary', async () => {
    const { job } = await seeded({ chapters: 0 });
    const model = fakeGenerator(SCRIPT);
    expect((await run(job, model)).status).toBe('succeeded');
    expect(model.reflectionRequests[0]?.subjects[0]?.summary).toContain('Line 1 of the teaching.');
  });

  it('fails, naming it, when there is nothing at all to write a question from', async () => {
    const { job } = await seeded({ chapters: 0, transcript: false });
    const row = await run(job);
    expect(row.status).toBe('failed');
    expect(row.error).toContain('no chapters, no summary and no transcript');
  });

  it('removes the whole-teaching question once the teaching has chapters', async () => {
    const { recordingId, job } = await seeded({ chapters: 0, summary: 'Short.' });
    await run(job);
    expect(await findRecordingQuestion(recordingId, handle)).not.toBeNull();

    // Chapters arrive later (a longer transcript, say), and the step runs again.
    await replaceChapters(
      recordingId,
      [
        { startMs: 0, title: 'Now one', summary: 'One.' },
        { startMs: 20 * MINUTE, title: 'Now two', summary: 'Two.' },
      ],
      CHAPTERS_BY,
      handle,
    );
    expect((await run(await claim(recordingId))).status).toBe('succeeded');
    expect(await findRecordingQuestion(recordingId, handle)).toBeNull();
    expect((await listChapterQuestionsForRecording(recordingId, handle)).size).toBe(2);
  });
});

describe('when the model falls short', () => {
  it('fails the job naming the chapter the model wrote nothing for, and writes nothing', async () => {
    const { recordingId, job } = await seeded();
    const forgetful: Generator = {
      name: 'forgetful',
      generate: () => Promise.reject(new GenerationError('not asked for here')),
      segmentChapters: () => Promise.reject(new GenerationError('not asked for here')),
      writeReflections: async (request) => ({
        reflections: request.subjects.slice(1).map((one) => ({ key: one.key, question: 'Fine?' })),
        promptVersion: 'reflections-1',
        spend: { model: 'f', modelVersion: 'f', inputTokens: 1, outputTokens: 1, costUsd: 0, requestId: 'r' },
      }),
    };
    const row = await run(job, forgetful);
    expect(row.status).toBe('failed');
    expect(row.error).toContain('“Part 1”');
    expect((await listChapterQuestionsForRecording(recordingId, handle)).size).toBe(0);
  });

  it('fails the job with the provider’s reason when the provider refuses', async () => {
    const { job } = await seeded();
    const refusing: Generator = {
      name: 'refusing',
      generate: () => Promise.reject(new GenerationError('not asked for here')),
      segmentChapters: () => Promise.reject(new GenerationError('not asked for here')),
      writeReflections: () => Promise.reject(new GenerationError('the model answered without calling the tool')),
    };
    const row = await run(job, refusing);
    expect(row.status).toBe('failed');
    expect(row.error).toContain('without calling the tool');
  });

  it('fails for a recording that does not exist', async () => {
    const { job } = await seeded();
    const row = await run({ ...job, recordingId: '00000000-0000-4000-8000-000000000000' });
    expect(row.status).toBe('failed');
    expect(row.error).toContain('no recording');
  });
});

describe('its place in the chain', () => {
  it('follows generate_chapters and hands on to embed', async () => {
    const { recordingId, job } = await seeded();
    // `seeded` claims a `generate_questions` job of its own, and the chain's enqueue is a no-op
    // while one is pending or running (the partial unique index). Finish it first, so the row
    // this test looks for is the one the chapters step queued and not the fixture's.
    await sql`update job set status = 'succeeded', finished_at = now() where id = ${job.id}`;
    const chaptersJob = await enqueueJob(
      { recordingId, step: 'generate_chapters', correlationId: 'chain' },
      handle,
    );
    await sql`update job set status = 'running', started_at = now() where id = ${chaptersJob.id}`;
    const generated = await run({ ...chaptersJob, status: 'running', startedAt: new Date() });
    expect(generated.status).toBe('succeeded');

    const pending = await sql<{ step: string; status: string; correlation_id: string }[]>`
      select step::text as step, status::text as status, correlation_id from job
      where recording_id = ${recordingId} and status = 'pending'
    `;
    expect(pending.map((one) => [one.step, one.status])).toEqual([['generate_questions', 'pending']]);
    expect(pending[0]?.correlation_id).toBe('chain');

    // The chapters were replaced, so every question is missing again; this run writes them all.
    expect((await listChapters(recordingId, handle)).length).toBeGreaterThan(0);
  });
});
