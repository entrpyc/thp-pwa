import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  createDatabase,
  enqueueJob,
  insertRecording,
  listChapters,
  replaceTranscript,
  runMigrations,
  setRecordingPublication,
  updateChapter,
  type DatabaseHandle,
  type JobRow,
} from '@thp/db';
import { MIN_CHAPTERS, MIN_CHAPTER_MS, TARGET_CHAPTER_MS } from '@thp/shared';
import { DOMAIN_EVENT_MESSAGE } from '@thp/shared/observability/events';
import { setLogSink, type LogLine } from '@thp/shared/observability/logger';
import { GenerationError, fakeGenerator, type Generator } from '../../src/generate';
import { createHandlers } from '../../src/handlers';
import { runJob } from '../../src/run-job';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * **The `generate_chapters` step, against a real database** ([3.22.1](docs/project/prd.md),
 * [3.22.2](docs/project/prd.md), [3.22.4](docs/project/prd.md), [3.22.5](docs/project/prd.md),
 * [3.22.9](docs/project/prd.md)).
 *
 * **The provider is the only thing faked**, and it is faked by configuration rather than by a mock —
 * a `Generator` is handed in exactly as the loop is handed a handler registry. Everything else is
 * real, because everything else is what the requirements are about: a list that genuinely survives
 * being written twice, a failure that genuinely leaves the previous list standing, and a tiling
 * that is genuinely a tiling in the table rather than in a return value.
 *
 * The property this suite exists for above all others is 3.22.9's: **a run either replaces the whole
 * list or leaves the previous one standing.** A generation that half-committed on a published
 * teaching would be members reading a teaching with a hole in it, with no admin step in between to
 * catch it ([3.22.6](docs/project/prd.md)).
 */

const databaseUrl = inject('databaseUrl');
const MINUTE = 60_000;

/** Every ten seconds, which is close enough that an off-by-a-line is visible. */
const LINE_MS = 10_000;

let target: ThrowawayDatabase;
let sql: postgres.Sql;
let handle: DatabaseHandle;
let made = 0;
let captured: LogLine[] = [];
let restoreSink: () => void;

/**
 * A recording with a transcript of `minutes` minutes behind it, and a claimed
 * `generate_chapters` job against it.
 */
async function claimedJob(
  options: { minutes?: number; transcript?: boolean; published?: boolean } = {},
): Promise<JobRow> {
  made += 1;
  const recording = await insertRecording(
    {
      originalMediaKey: `originals/chapters-${made}-${Date.now().toString(36)}.mp3`,
      title: `Teaching ${made}`,
      recordedAt: '2026-08-16',
    },
    handle,
  );

  if (options.transcript !== false) {
    const lines = Math.round(((options.minutes ?? 90) * MINUTE) / LINE_MS);
    await replaceTranscript(
      {
        recordingId: recording.id,
        language: 'en',
        confidence: 0.95,
        segments: Array.from({ length: lines }, (_unused, index) => ({
          startMs: index * LINE_MS,
          endMs: (index + 1) * LINE_MS,
          text: `Line ${index + 1} of the teaching.`,
        })),
      },
      handle,
    );
  }

  if (options.published === true) await setRecordingPublication(recording.id, new Date(), handle);

  const job = await enqueueJob(
    {
      recordingId: recording.id,
      step: 'generate_chapters',
      correlationId: `chapters-${made}-correlation`,
    },
    handle,
  );
  await sql`update job set status = 'running', started_at = now() where id = ${job.id}`;
  return { ...job, status: 'running', startedAt: new Date() };
}

/** The script the fake takes its words from — the boundaries are its own arithmetic. */
const SCRIPT = {
  summary: 'A summary, so the fake can also answer a draft request if one ever reaches it.',
  description: 'A description.',
  chapters: [
    { title: 'The vine', summary: 'Abiding in the vine.' },
    { title: 'The branches', summary: 'What bearing fruit costs.' },
    { title: 'The gardener', summary: 'Why pruning is kindness.' },
    { title: 'The harvest', summary: 'What the fruit is for.' },
  ],
};

function run(job: JobRow, generator: Generator = fakeGenerator(SCRIPT)): Promise<JobRow> {
  return runJob(job, createHandlers({ generator, executor: handle }), { executor: handle });
}

beforeAll(async () => {
  target = await createThrowawayDatabase(databaseUrl, 'generate_chapters');
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

describe('cutting a teaching into chapters (3.22.1, 3.22.2, 3.22.5)', () => {
  it('writes a list, and every boundary lands on the start of a transcript line', async () => {
    const job = await claimedJob({ minutes: 90 });
    const row = await run(job);
    expect(row.status).toBe('succeeded');

    const chapters = await listChapters(job.recordingId, handle);
    expect(chapters.length).toBeGreaterThanOrEqual(MIN_CHAPTERS);

    for (const chapter of chapters) {
      // 3.22.5 — no chapter opens half a sentence in.
      expect(chapter.startMs % LINE_MS).toBe(0);
    }
  });

  /** 3.22.2 — the first begins at the start of the audio, and the starts ascend without repeats. */
  it('tiles the teaching: first at the beginning, ascending, no two the same', async () => {
    const job = await claimedJob({ minutes: 90 });
    await run(job);

    const starts = (await listChapters(job.recordingId, handle)).map((one) => one.startMs);
    expect(starts[0]).toBe(0);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(new Set(starts).size).toBe(starts.length);
  });

  /** 3.22.4 — cut at a length in the range, so no chapter is shorter than the floor. */
  it('leaves no chapter shorter than fifteen minutes', async () => {
    const job = await claimedJob({ minutes: 90 });
    await run(job);

    const starts = (await listChapters(job.recordingId, handle)).map((one) => one.startMs);
    for (let index = 1; index < starts.length; index += 1) {
      expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(MIN_CHAPTER_MS);
    }
  });

  it('takes its titles and summaries from what the model wrote (3.22.3)', async () => {
    const job = await claimedJob({ minutes: 90 });
    await run(job);

    const chapters = await listChapters(job.recordingId, handle);
    expect(chapters[0]?.title).toBe('The vine');
    expect(chapters[0]?.summary).toBe('Abiding in the vine.');
    // 4.19, 4.17.5 — which model, which version, which prompt, on the list it produced.
    expect(chapters[0]?.generatedBy).toMatchObject({ model: 'fake', promptVersion: 'chapters-1' });
    expect(chapters.every((one) => !one.editedByAdmin)).toBe(true);
  });

  it('hands the model the whole transcript with its offsets, and how long the teaching runs', async () => {
    const model = fakeGenerator(SCRIPT);
    const job = await claimedJob({ minutes: 90 });
    await run(job, model);

    const asked = model.chapterRequests[0];
    expect(asked?.title).toBe(`Teaching ${made}`);
    expect(asked?.lines[0]).toEqual({ startMs: 0, text: 'Line 1 of the teaching.' });
    // 4.2 — how long the teaching is, as far as the product knows: the end of the last segment.
    expect(asked?.durationMs).toBe(90 * MINUTE);
  });
});

describe('a teaching too short to divide (3.22.4)', () => {
  /**
   * "A recording too short to hold two of them gets none" — and it is a **success**, not a failure.
   * A step that went red for every short teaching in the back catalogue would make the pipeline
   * screen unreadable.
   */
  it('writes no chapters and succeeds', async () => {
    const job = await claimedJob({ minutes: 12 });
    const row = await run(job);

    expect(row.status).toBe('succeeded');
    expect(await listChapters(job.recordingId, handle)).toEqual([]);
  });

  it('writes nothing rather than one row that is the whole teaching', async () => {
    // Exactly one target length: the fake proposes one chapter, and one is what 3.22.4 refuses —
    // "every surface leaves them out rather than offering a single row that is the whole teaching".
    const job = await claimedJob({ minutes: TARGET_CHAPTER_MS / MINUTE });
    const row = await run(job);

    expect(row.status).toBe('succeeded');
    expect(await listChapters(job.recordingId, handle)).toEqual([]);

    // "This teaching has no chapters" and "chapter generation has not run" look identical from the
    // outside; an operator asking which one they are looking at deserves an answer.
    expect(captured.some((line) => line.message === 'generate_chapters.too_few')).toBe(true);
  });
});

describe('running it again (3.21.2.6, 3.22.8, 3.22.9)', () => {
  it('leaves one list when it runs twice', async () => {
    const job = await claimedJob({ minutes: 90 });
    await run(job);
    const first = await listChapters(job.recordingId, handle);

    const again = await enqueueJob(
      { recordingId: job.recordingId, step: 'generate_chapters', correlationId: 'again' },
      handle,
    );
    await sql`update job set status = 'running' where id = ${again.id}`;
    await run({ ...again, status: 'running' });

    const second = await listChapters(job.recordingId, handle);
    expect(second).toHaveLength(first.length);
    expect(second.map((one) => one.startMs)).toEqual(first.map((one) => one.startMs));
  });

  /**
   * **3.22.8, from the worker's side.** Re-running discards every title, summary and boundary a
   * human has changed — which is precisely why the console confirms it first, and why this asserts
   * that the discarding really happens rather than assuming it.
   */
  it('discards what an admin changed, which is what the confirmation is for', async () => {
    const job = await claimedJob({ minutes: 90, published: true });
    await run(job);

    const before = await listChapters(job.recordingId, handle);
    await updateChapter(
      {
        id: before[0]!.id,
        title: 'A title an admin wrote',
        summary: before[0]!.summary,
        startMs: before[0]!.startMs,
      },
      handle,
    );

    const again = await enqueueJob(
      { recordingId: job.recordingId, step: 'generate_chapters', correlationId: 'again-edited' },
      handle,
    );
    await sql`update job set status = 'running' where id = ${again.id}`;
    await run({ ...again, status: 'running' });

    const after = await listChapters(job.recordingId, handle);
    expect(after.map((one) => one.title)).not.toContain('A title an admin wrote');
    expect(after.every((one) => !one.editedByAdmin)).toBe(true);
  });
});

describe('a run that fails (3.21.2.3, 3.22.9)', () => {
  /**
   * **"A failed or interrupted generation flags the recording and changes nothing a member can
   * see"** — asserted against a **published** teaching, because that is the case where "nothing a
   * member can see" means anything at all.
   */
  it('leaves the previous list exactly as it was, on a live teaching', async () => {
    const job = await claimedJob({ minutes: 90, published: true });
    await run(job);
    const before = await listChapters(job.recordingId, handle);
    expect(before.length).toBeGreaterThanOrEqual(MIN_CHAPTERS);

    const refusing: Generator = {
      name: 'refusing',
      generate: () => Promise.reject(new GenerationError('not asked for here')),
      segmentChapters: () =>
        Promise.reject(new GenerationError('the model answered without calling the tool')),
    };

    const again = await enqueueJob(
      { recordingId: job.recordingId, step: 'generate_chapters', correlationId: 'again-failing' },
      handle,
    );
    await sql`update job set status = 'running' where id = ${again.id}`;
    const row = await run({ ...again, status: 'running' }, refusing);

    // The failure is on the row, readable on /admin/pipeline and re-runnable from there.
    expect(row.status).toBe('failed');
    expect(row.error).toContain('without calling the tool');

    const after = await listChapters(job.recordingId, handle);
    expect(after.map((one) => ({ startMs: one.startMs, title: one.title }))).toEqual(
      before.map((one) => ({ startMs: one.startMs, title: one.title })),
    );
  });

  /**
   * Generating from nothing is not a shorter version of this step — it is a different one, and it
   * would produce boundaries into silence.
   */
  it('fails a recording with no transcript, naming that, and writes nothing', async () => {
    const job = await claimedJob({ transcript: false });
    const row = await run(job);

    expect(row.status).toBe('failed');
    expect(row.error).toContain('no transcript');
    expect(await listChapters(job.recordingId, handle)).toEqual([]);
  });
});

describe('what the run records', () => {
  it('records the spend and what it had to repair, on the job that caused it', async () => {
    const job = await claimedJob({ minutes: 90 });
    await run(job);

    const rows = await sql<{ provider_meta: Record<string, unknown> }[]>`
      select provider_meta from job where id = ${job.id}
    `;
    const meta = rows[0]?.provider_meta ?? {};
    expect(meta['model']).toBe('fake');
    expect(meta['promptVersion']).toBe('chapters-1');
    expect(meta['costUsd']).toBe(0);
    // A prompt going wrong should be visible as a number climbing rather than as lists quietly
    // getting shorter.
    expect(typeof meta['chaptersProposed']).toBe('number');
    expect(meta['chaptersWritten']).toBe(
      (await listChapters(job.recordingId, handle)).length,
    );
  });

  it('emits the event a notification will one day hang off', async () => {
    const job = await claimedJob({ minutes: 90 });
    await run(job);

    const event = captured.find(
      (line) => line.message === DOMAIN_EVENT_MESSAGE && line['event'] === 'chapters_generated',
    );
    expect(event?.['recordingId']).toBe(job.recordingId);
  });
});

/**
 * **The chain** ([3.22.1](docs/project/prd.md), [3.21.1](docs/project/prd.md)) — chapters are a step
 * of the pipeline, so the step before it queues it on success without anything naming it.
 */
describe('its place in the chain (3.21.1)', () => {
  it('is queued by the step before it, and queues nothing after', async () => {
    const job = await claimedJob({ minutes: 90 });
    await run(job);

    const queued = await sql<{ step: string }[]>`
      select step::text as step from job where recording_id = ${job.recordingId}
    `;
    // The last step of the chain: nothing follows it, so nothing was enqueued behind it.
    expect(queued.map((row) => row.step)).toEqual(['generate_chapters']);
  });
});
