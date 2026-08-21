import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  createDatabase,
  enqueueJob,
  findTranscriptByRecording,
  insertRecording,
  listSegments,
  runMigrations,
  type DatabaseHandle,
  type JobRow,
} from '@thp/db';
import { UPLOAD_GRANT_SECONDS, mediaStore, mintOriginalKey, type MediaStore } from '@thp/media';
import { ACCEPTED_AUDIO_FORMATS } from '@thp/shared';
import { setLogSink, type LogLine } from '@thp/shared/observability/logger';
import {
  TranscriptionError,
  fakeTranscriber,
  type FakeScript,
  type FakeTranscriber,
} from '../../src/asr';
import { createHandlers } from '../../src/handlers';
import { runJob } from '../../src/run-job';
import { CONFIDENCE_THRESHOLD, TRANSCRIPTION_GRANT_SECONDS } from '../../src/transcribe';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * The `transcribe` handler, against a real database and the real object store.
 *
 * **The provider is the only thing faked**, and it is faked by configuration rather than by a mock:
 * a `Transcriber` is handed in exactly as the loop is handed a handler registry. Everything else is
 * real, because everything else is what the criteria are about — a signed URL that genuinely
 * fetches the object, a transcript that genuinely survives being written twice, and a failure that
 * genuinely leaves the ledger saying so.
 */

const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const AUDIO = ACCEPTED_AUDIO_FORMATS.mp3;

const SCRIPT: FakeScript = {
  language: 'en',
  confidence: 0.94,
  durationSeconds: 372.5,
  segments: [
    { startMs: 0, endMs: 4120, text: "Good morning, and welcome to this morning's teaching." },
    { startMs: 4120, endMs: 9880, text: 'We are picking up where we left off last week.' },
    { startMs: 9880, endMs: 15_340, text: 'Before we read, a word about why this matters.' },
  ],
};

let target: ThrowawayDatabase;
let sql: postgres.Sql;
let handle: DatabaseHandle;
let store: MediaStore;
let recordings = 0;
let captured: LogLine[] = [];
let restoreSink: () => void;

/** The bytes of a "recording", genuinely in the bucket. */
function bytes(size = 128): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(size)).fill(7);
}

/** Put an object in the store and hand back its key. */
async function uploadedObject(size = 128): Promise<string> {
  const key = mintOriginalKey(AUDIO);
  const url = await store.presignPut({
    key,
    contentType: AUDIO,
    expiresInSeconds: UPLOAD_GRANT_SECONDS,
  });
  const put = await fetch(url, { method: 'PUT', headers: { 'content-type': AUDIO }, body: bytes(size) });
  expect(put.status).toBe(200);
  return key;
}

/** A recording whose object is really there, and a `transcribe` job claimed against it. */
async function claimedJob(options: { key?: string } = {}): Promise<JobRow> {
  recordings += 1;
  const key = options.key ?? (await uploadedObject());
  const recording = await insertRecording(
    { originalMediaKey: key, title: `Teaching ${recordings}`, recordedAt: '2026-06-07' },
    handle,
  );
  const job = await enqueueJob(
    { recordingId: recording.id, step: 'transcribe', correlationId: `transcribe-${recordings}` },
    handle,
  );
  await sql`update job set status = 'running', started_at = now() where id = ${job.id}`;
  return { ...job, status: 'running', startedAt: new Date() };
}

/** Run the real registry with this transcriber behind the `transcribe` step. */
async function run(job: JobRow, asr: FakeTranscriber): Promise<JobRow> {
  return runJob(job, createHandlers({ transcriber: asr, media: store, executor: handle }), {
    executor: handle,
  });
}

interface LedgerRow {
  readonly step: string;
  readonly status: string;
  readonly error: string | null;
  readonly provider_meta: Record<string, unknown> | null;
}

async function ledger(recordingId: string): Promise<LedgerRow[]> {
  return (await sql<LedgerRow[]>`
    select step::text as step, status::text as status, error, provider_meta
    from job where recording_id = ${recordingId} order by enqueued_at, id
  `) as unknown as LedgerRow[];
}

/** A transcriber that refuses, the way the real one refuses. */
function refusingTranscriber(message: string): FakeTranscriber {
  const requests: FakeTranscriber['requests'] = [];
  return {
    name: 'fake',
    requests,
    transcribe: () => Promise.reject(new TranscriptionError(message)),
  };
}

beforeAll(async () => {
  // The suite's own bucket, not the one `.env` names. The store reads five values with no defaults.
  Object.assign(process.env, settings);
  store = mediaStore();

  target = await createThrowawayDatabase(databaseUrl, 'transcribe');
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

describe('a recording that transcribes', () => {
  it('writes one transcript and its segments for the recording the job names', async () => {
    const job = await claimedJob();

    const row = await run(job, fakeTranscriber(SCRIPT));

    expect(row.status).toBe('succeeded');
    const transcript = await findTranscriptByRecording(job.recordingId, handle);
    expect(transcript).not.toBeNull();
    expect((await listSegments(transcript!.id, handle)).map((one) => one.text)).toEqual(
      SCRIPT.segments.map((one) => one.text),
    );
  });

  it('records the language it was transcribed in', async () => {
    const job = await claimedJob();
    const asr = fakeTranscriber(SCRIPT);

    await run(job, asr);

    // Asked for explicitly, and written down. Pinned rather than detected — docs/project/prd.md
    // 3.5.7's field stays honest, and a second language later is an adapter change.
    expect(asr.requests[0]?.language).toBe('en');
    expect((await findTranscriptByRecording(job.recordingId, handle))?.language).toBe('en');
  });

  it('gives every segment a start, an end and text, in order and without overlap', async () => {
    const job = await claimedJob();
    await run(job, fakeTranscriber(SCRIPT));

    const transcript = await findTranscriptByRecording(job.recordingId, handle);
    const segments = await listSegments(transcript!.id, handle);
    expect(segments).toHaveLength(SCRIPT.segments.length);

    let previousEnd = -1;
    for (const segment of segments) {
      expect(segment.text.length).toBeGreaterThan(0);
      expect(segment.endMs).toBeGreaterThan(segment.startMs);
      // Each one begins no earlier than the last one ended: a follow-along highlight that jumped
      // backwards would be a transcript nobody could read against the audio.
      expect(segment.startMs).toBeGreaterThanOrEqual(previousEnd);
      previousEnd = segment.endMs;
    }
  });

  it('records the model, its version, the billed duration and the cost on the job', async () => {
    const job = await claimedJob();

    const row = await run(job, fakeTranscriber(SCRIPT));

    // docs/project/prd.md §7 wants spend measured rather than estimated, and this row is the
    // measurement. The four facts, plus the provider's own id for the call.
    const meta = row.providerMeta as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual([
      'costUsd',
      'durationSeconds',
      'model',
      'modelVersion',
      'requestId',
    ]);
    expect(meta['durationSeconds']).toBe(SCRIPT.durationSeconds);
    expect(meta['model']).toBe('fake');
    // And it is on the row an operator queries, not only on the object the handler returned.
    const [persisted] = await ledger(job.recordingId);
    expect(persisted?.provider_meta).toEqual(meta);
  });

  it('chains forward once the transcript is confident', async () => {
    const job = await claimedJob();

    await run(job, fakeTranscriber(SCRIPT));

    expect((await ledger(job.recordingId)).map((row) => [row.step, row.status])).toEqual([
      ['transcribe', 'succeeded'],
      ['generate_draft', 'pending'],
    ]);
  });
});

describe('reading the original', () => {
  it('hands the provider a URL that resolves to the uploaded object', async () => {
    const key = await uploadedObject(192);
    const job = await claimedJob({ key });
    const asr = fakeTranscriber(SCRIPT);

    await run(job, asr);

    const audioUrl = asr.requests[0]?.audioUrl ?? '';
    expect(audioUrl).toContain(key);
    // The provider fetches the object itself. The bytes never pass through the worker, which is the
    // same boundary the presigned PUT holds on the way in — so the assertion is that the URL
    // *works*, not that it looks right.
    const fetched = await fetch(audioUrl);
    expect(fetched.status).toBe(200);
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(bytes(192));
  });

  it('asks for a grant that expires within the fixed window', async () => {
    const job = await claimedJob();
    const asr = fakeTranscriber(SCRIPT);

    await run(job, asr);

    const expires = new URL(asr.requests[0]?.audioUrl ?? '').searchParams.get('X-Amz-Expires');
    expect(Number(expires)).toBe(TRANSCRIPTION_GRANT_SECONDS);
  });

  it('leaves the original exactly as it was', async () => {
    const key = await uploadedObject(256);
    const before = await store.head(key);
    const job = await claimedJob({ key });

    await run(job, fakeTranscriber(SCRIPT));

    // docs/project/prd.md 3.4.9's non-negotiable. Nothing here can break it — there is no delete
    // and no put on the port to reach for — and this is what says so out loud.
    expect(await store.head(key)).toEqual(before);
  });

  it('fails naming the key when the object is missing, without calling the provider', async () => {
    recordings += 1;
    const missing = mintOriginalKey(AUDIO);
    const recording = await insertRecording(
      { originalMediaKey: missing, title: 'Points at nothing', recordedAt: '2026-06-08' },
      handle,
    );
    const queued = await enqueueJob(
      { recordingId: recording.id, step: 'transcribe', correlationId: 'missing-object' },
      handle,
    );
    await sql`update job set status = 'running', started_at = now() where id = ${queued.id}`;
    const asr = fakeTranscriber(SCRIPT);

    const row = await run({ ...queued, status: 'running' }, asr);

    expect(row.status).toBe('failed');
    expect(row.error).toContain(missing);
    // Refused before the provider was asked, so a broken row costs nothing.
    expect(asr.requests).toHaveLength(0);
  });
});

describe('running the same recording twice', () => {
  it('leaves exactly one transcript and one set of segments', async () => {
    const job = await claimedJob();

    await run(job, fakeTranscriber(SCRIPT));
    // The same job row again, exactly as the startup sweep and Ticket 04's re-run produce it.
    await sql`update job set status = 'running', finished_at = null where id = ${job.id}`;
    await run(job, fakeTranscriber(SCRIPT));

    const [counts] = await sql<{ transcripts: string; segments: string }[]>`
      select
        (select count(*)::text from transcript where recording_id = ${job.recordingId}) as transcripts,
        (select count(*)::text from segment
          join transcript on transcript.id = segment.transcript_id
          where transcript.recording_id = ${job.recordingId}) as segments
    `;
    expect(counts?.transcripts).toBe('1');
    expect(counts?.segments).toBe(String(SCRIPT.segments.length));
  });

  it('keeps the second run’s text, not the first’s', async () => {
    const job = await claimedJob();

    await run(job, fakeTranscriber(SCRIPT));
    await sql`update job set status = 'running', finished_at = null where id = ${job.id}`;
    await run(
      job,
      fakeTranscriber({
        language: 'en',
        confidence: 0.99,
        durationSeconds: 10,
        segments: [{ startMs: 0, endMs: 2000, text: 'A better transcription.' }],
      }),
    );

    const transcript = await findTranscriptByRecording(job.recordingId, handle);
    expect((await listSegments(transcript!.id, handle)).map((one) => one.text)).toEqual([
      'A better transcription.',
    ]);
  });

  it('writes the transcript and its segments as one thing', async () => {
    const job = await claimedJob();

    // A start beyond what an integer column holds: the segment insert fails inside the transaction
    // that had just written the transcript row. A transcript with a hole in it is one nothing
    // downstream could tell from a complete one.
    const row = await run(
      job,
      fakeTranscriber({
        language: 'en',
        confidence: 0.9,
        durationSeconds: 10,
        segments: [{ startMs: 9_999_999_999, endMs: 10_000_000_000, text: 'Too far in.' }],
      }),
    );

    expect(row.status).toBe('failed');
    // It failed on the *segment* write specifically — otherwise this would prove nothing about
    // atomicity, only that a handler that fails early writes nothing.
    expect(row.error).toContain('insert into "segment"');
    expect(await findTranscriptByRecording(job.recordingId, handle)).toBeNull();
  });
});

describe('a provider that refuses', () => {
  it('fails the job with the reason and enqueues nothing', async () => {
    const job = await claimedJob();

    const row = await run(job, refusingTranscriber('the provider could not decode the audio'));

    expect(row.status).toBe('failed');
    expect(row.error).toBe('the provider could not decode the audio');
    // docs/project/prd.md 3.21.2.3: the pipeline halts and flags. Nothing downstream is generated
    // from a recording that has no transcript.
    expect((await ledger(job.recordingId)).map((one) => one.step)).toEqual(['transcribe']);
    expect(await findTranscriptByRecording(job.recordingId, handle)).toBeNull();
  });

  it('fails a transcript with no segments in it rather than succeeding emptily', async () => {
    const job = await claimedJob();

    const row = await run(
      job,
      fakeTranscriber({ language: 'en', confidence: 0.99, durationSeconds: 5, segments: [] }),
    );

    // Silence is a recording nobody wants a summary of, and an empty transcript would chain forward
    // looking exactly like a successful one.
    expect(row.status).toBe('failed');
    expect(await findTranscriptByRecording(job.recordingId, handle)).toBeNull();
    expect((await ledger(job.recordingId)).map((one) => one.step)).toEqual(['transcribe']);
  });
});

describe('the confidence gate', () => {
  const doubted: FakeScript = {
    language: 'en',
    confidence: CONFIDENCE_THRESHOLD - 0.2,
    durationSeconds: 61,
    segments: [
      { startMs: 0, endMs: 3200, text: 'the the and then it was' },
      { startMs: 3200, endMs: 7400, text: 'something about a a a river maybe' },
    ],
  };

  it('writes the transcript and then fails the job, naming both numbers', async () => {
    const job = await claimedJob();

    const row = await run(job, fakeTranscriber(doubted));

    // **Written**, because the admin has to be able to read it to judge it and Story 5's correction
    // has nothing to correct otherwise.
    const transcript = await findTranscriptByRecording(job.recordingId, handle);
    expect(transcript).not.toBeNull();
    expect(transcript?.confidence).toBeCloseTo(doubted.confidence, 5);
    expect(await listSegments(transcript!.id, handle)).toHaveLength(2);

    // **And then failed**, which is how it becomes visible in Ticket 04's failed column.
    expect(row.status).toBe('failed');
    expect(row.error).toContain(String(doubted.confidence));
    expect(row.error).toContain(String(CONFIDENCE_THRESHOLD));
  });

  it('generates nothing from a transcript the machine itself doubted', async () => {
    const job = await claimedJob();

    await run(job, fakeTranscriber(doubted));

    // The whole of docs/project/prd.md 3.5.8's "rather than proceeding to downstream generation on
    // bad input". The admin's escape hatch is Ticket 04's per-step re-run of `generate_draft`.
    expect((await ledger(job.recordingId)).map((one) => [one.step, one.status])).toEqual([
      ['transcribe', 'failed'],
    ]);
  });

  it('lets a transcript exactly at the threshold through', async () => {
    const job = await claimedJob();

    const row = await run(job, fakeTranscriber({ ...SCRIPT, confidence: CONFIDENCE_THRESHOLD }));

    expect(row.status).toBe('succeeded');
    expect((await ledger(job.recordingId)).map((one) => one.step)).toEqual([
      'transcribe',
      'generate_draft',
    ]);
  });
});

describe('what the log says about a transcription', () => {
  it('carries the job, the recording, the correlation id and the provider request id', async () => {
    const job = await claimedJob();
    const asr = fakeTranscriber(SCRIPT);

    await run(job, asr);

    const started = captured.find((line) => line.message === 'transcribe.started');
    const succeeded = captured.filter((line) => line.message === 'transcribe.succeeded');
    expect(started).toMatchObject({ jobId: job.id, recordingId: job.recordingId });
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]).toMatchObject({
      jobId: job.id,
      recordingId: job.recordingId,
      // Off the row, not out of an async frame — there is no request behind this process. This is
      // what completes the API request → job → provider call span.
      correlationId: job.correlationId,
      requestId: 'fake-1',
      provider: 'fake',
      language: 'en',
      segments: SCRIPT.segments.length,
    });
  });

  it('says which of the two failures happened', async () => {
    const refused = await claimedJob();
    await run(refused, refusingTranscriber('nope'));
    expect(captured.filter((line) => line.message === 'transcribe.failed')).toHaveLength(1);
    expect(captured.filter((line) => line.message === 'transcribe.low_confidence')).toHaveLength(0);

    captured = [];
    const doubted = await claimedJob();
    await run(doubted, fakeTranscriber({ ...SCRIPT, confidence: 0.1 }));

    // A transcript that was written and doubted is a different event from one that never arrived,
    // and the two must not read the same in the log.
    const low = captured.filter((line) => line.message === 'transcribe.low_confidence');
    expect(low).toHaveLength(1);
    expect(low[0]).toMatchObject({
      recordingId: doubted.recordingId,
      confidence: 0.1,
      threshold: CONFIDENCE_THRESHOLD,
    });
  });
});
