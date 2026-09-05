import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  ACCEPTED_AUDIO_FORMATS,
  API_PREFIX,
  CORRELATION_ID_HEADER,
  DEFAULT_PLAYBACK_SPEED,
  FIRST_PIPELINE_STEP,
  MAX_UPLOAD_BYTES,
  PIPELINE_STEPS,
  RECORDINGS_PATH,
  RECORDING_UPLOADS_PATH,
  ROLE,
  type RecordingSummary,
  type UploadGrantPayload,
} from '@thp/shared';
import { setLogSink, type LogLine } from '@thp/shared/observability/logger';
import {
  closeDatabase,
  createDatabase,
  findTranscriptByRecording,
  listSegments,
  type DatabaseHandle,
} from '@thp/db';
import { setQueue, type EnqueuedJob, type Queue } from '@/server/jobs/queue';
import { finaliseUpload } from '@/server/recordings/service';
import { mediaStore, mintOriginalKey, UPLOAD_GRANT_SECONDS } from '@thp/media';
import type { Actor } from '@/server/auth/policy';
import { startWorkerLoop } from '../../../worker/src/loop';
import { createHandlers } from '../../../worker/src/handlers';
import { fakeTranscriber, type FakeScript } from '../../../worker/src/asr';
import { fakeGenerator } from '../../../worker/src/generate';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';

/**
 * **An upload starts the pipeline on its own** (docs/project/prd.md, 3.21.2.1).
 *
 * The seam this suite is about is the one between two processes: the API finalises an upload, and a
 * worker nobody told about it picks the work up. So the last test here does not simulate the
 * worker — it runs the real loop, against the real object store, over a recording created through
 * the real HTTP API, and asserts the ledger afterwards.
 *
 * The loop is driven for a bounded time and stopped rather than started as a process, so the suite
 * has nothing to kill.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const UPLOADS_URL = `${baseUrl}${API_PREFIX}${RECORDING_UPLOADS_PATH}`;
const RECORDINGS_URL = `${baseUrl}${API_PREFIX}${RECORDINGS_PATH}`;

let admin: TestAccount;
let adminCookie: string;
let sql: postgres.Sql;
let handle: DatabaseHandle;

interface LedgerRow {
  readonly id: string;
  readonly step: string;
  readonly status: string;
  readonly attempt: number;
  readonly correlation_id: string;
  readonly provider_meta: unknown;
}

async function post<T>(
  url: string,
  body: unknown,
  correlationId?: string,
): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      cookie: adminCookie,
      ...(correlationId === undefined ? {} : { [CORRELATION_ID_HEADER]: correlationId }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

function bytes(size: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(size)).fill(7);
}

/** A grant, and the bytes actually behind it. The API never sees them. */
async function uploaded(size = 128): Promise<UploadGrantPayload> {
  const grant = await post<UploadGrantPayload>(UPLOADS_URL, {
    filename: 'sunday-teaching.mp3',
    contentType: ACCEPTED_AUDIO_FORMATS.mp3,
    size,
  });
  expect(grant.status).toBe(200);
  const put = await fetch(grant.body.url, {
    method: 'PUT',
    headers: { 'content-type': grant.body.contentType },
    body: bytes(size),
  });
  expect(put.status).toBe(200);
  return grant.body;
}

async function ledger(recordingId: string): Promise<LedgerRow[]> {
  return (await sql<LedgerRow[]>`
    select id, step::text as step, status::text as status, attempt, correlation_id, provider_meta
    from job where recording_id = ${recordingId} order by enqueued_at, id
  `) as unknown as LedgerRow[];
}

async function recordingsFor(key: string): Promise<{ id: string }[]> {
  return (await sql<{ id: string }[]>`
    select id from recording where original_media_key = ${key}
  `) as unknown as { id: string }[];
}

async function waitFor(what: string, predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  // The suite's own bucket and the suite's own database, not the ones `.env` names.
  Object.assign(process.env, settings);
  process.env['DATABASE_URL'] = databaseUrl;

  sql = postgres(databaseUrl, { max: 4, onnotice: () => {} });
  handle = createDatabase({ url: databaseUrl, max: 6 });

  const signedIn = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'pipeline-admin');
  admin = signedIn.account;
  adminCookie = signedIn.cookie;
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await closeDatabase();
  await sql?.end({ timeout: 5 });
  await closeTestDatabase();
});

describe('finalising an upload', () => {
  it('writes the recording and its first job together', async () => {
    const grant = await uploaded();
    const created = await post<RecordingSummary>(RECORDINGS_URL, {
      key: grant.key,
      title: 'The pipeline starts itself',
      recordedAt: '2026-03-08',
    });
    expect(created.status).toBe(201);

    const rows = await ledger(created.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.step).toBe(FIRST_PIPELINE_STEP);
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.attempt).toBe(1);
    // Nothing has run it: the worker is a separate process and this one only queued the work.
    expect(rows[0]?.provider_meta).toBeNull();
  }, 90_000);

  it('carries the finalise request correlation id onto the job', async () => {
    const grant = await uploaded();
    const correlationId = `finalise-chain-${Date.now().toString(36)}`;

    const created = await post<RecordingSummary>(
      RECORDINGS_URL,
      { key: grant.key, title: 'Traceable', recordedAt: '2026-03-09' },
      correlationId,
    );
    expect(created.status).toBe(201);

    const rows = await ledger(created.body.id);
    // The id crosses the process boundary on the row — there is no async frame to inherit it from
    // in the worker (core-listening scope tdd § Key choices).
    expect(rows[0]?.correlation_id).toBe(correlationId);
  }, 90_000);

  it('enqueues nothing when the finalisation is refused', async () => {
    // Ticket 01's refusals, replayed: an unused grant, a file that arrived over the ceiling, and a
    // key that is already a recording. None of them may leave work behind.
    const unused = await post<UploadGrantPayload>(UPLOADS_URL, {
      filename: 'never-sent.mp3',
      contentType: ACCEPTED_AUDIO_FORMATS.mp3,
      size: 100,
    });
    expect((await post(RECORDINGS_URL, { key: unused.body.key, title: 'A', recordedAt: '2026-01-01' })).status).toBe(409);

    const oversized = await post<UploadGrantPayload>(UPLOADS_URL, {
      filename: 'huge.mp3',
      contentType: ACCEPTED_AUDIO_FORMATS.mp3,
      size: 100,
    });
    await fetch(oversized.body.url, {
      method: 'PUT',
      headers: { 'content-type': oversized.body.contentType },
      body: bytes(MAX_UPLOAD_BYTES + 1),
    });
    expect((await post(RECORDINGS_URL, { key: oversized.body.key, title: 'B', recordedAt: '2026-01-01' })).status).toBe(409);

    const grant = await uploaded();
    const first = await post<RecordingSummary>(RECORDINGS_URL, {
      key: grant.key,
      title: 'Once',
      recordedAt: '2026-01-02',
    });
    expect(first.status).toBe(201);
    const twice = await post(RECORDINGS_URL, { key: grant.key, title: 'Twice', recordedAt: '2026-01-02' });
    expect(twice.status).toBe(409);

    // The refused keys are not recordings, so they have no jobs; and the one that *was* finalised
    // has exactly the one job its single successful finalisation queued.
    expect(await recordingsFor(unused.body.key)).toHaveLength(0);
    expect(await recordingsFor(oversized.body.key)).toHaveLength(0);
    expect(await ledger(first.body.id)).toHaveLength(1);
  }, 180_000);

  it('writes no recording when the enqueue fails', async () => {
    // The whole point of one transaction: there is no state in which a recording exists and its
    // first job does not. Driven in-process, because the only way to see it is an enqueue that
    // refuses — which the real queue cannot be asked to do.
    const key = mintOriginalKey(ACCEPTED_AUDIO_FORMATS.mp3);
    const url = await mediaStore().presignPut({
      key,
      contentType: ACCEPTED_AUDIO_FORMATS.mp3,
      expiresInSeconds: UPLOAD_GRANT_SECONDS,
    });
    expect(
      (await fetch(url, { method: 'PUT', headers: { 'content-type': ACCEPTED_AUDIO_FORMATS.mp3 }, body: bytes(64) })).status,
    ).toBe(200);

    const refusing: Queue = {
      name: 'refusing',
      enqueue: (): Promise<EnqueuedJob> => Promise.reject(new Error('the ledger refused this job')),
      findUnfinished: (): Promise<EnqueuedJob | null> => Promise.resolve(null),
    };
    const restoreQueue = setQueue(refusing);
    const silence = setLogSink(() => {});
    const actor: Actor = {
      id: admin.id,
      email: admin.email,
      displayName: admin.displayName,
      role: ROLE.admin,
      preferredPlaybackSpeed: DEFAULT_PLAYBACK_SPEED,
      avatarKey: null,
    };

    try {
      await expect(
        finaliseUpload(actor, { key, title: 'Rolled back', recordedAt: '2026-03-10' }),
      ).rejects.toThrow();
    } finally {
      restoreQueue();
    }

    try {
      // Neither change landed. The object is still in the bucket — nothing in this product deletes
      // — so the admin finalises the same key again and gets a recording with a job.
      expect(await recordingsFor(key)).toHaveLength(0);
      const retried = await finaliseUpload(actor, {
        key,
        title: 'Rolled back',
        recordedAt: '2026-03-10',
      });
      expect(await ledger(retried.id)).toHaveLength(1);
    } finally {
      silence();
    }
  }, 120_000);
});

/** What the drafting provider would have written. The second of two fakes in this suite. */
const DRAFT = {
  summary: 'The teaching stays with the second chapter throughout.',
  description: 'A close reading of the second chapter.',
};

/** What the provider would have said. The only thing in this suite that is not real. */
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

describe('presign, PUT, finalise, worker', () => {
  it('leaves a recording with a transcript, its segments, and both steps succeeded', async () => {
    const captured: LogLine[] = [];
    const restoreSink = setLogSink((line) => captured.push(line));

    const correlationId = `end-to-end-${Date.now().toString(36)}`;
    const grant = await uploaded(256);
    const created = await post<RecordingSummary>(
      RECORDINGS_URL,
      { key: grant.key, title: 'End to end', recordedAt: '2026-03-11' },
      correlationId,
    );
    expect(created.status).toBe(201);

    // The real loop, against the real ledger and the real object store. Nothing told it about this
    // upload. The transcriber is the fake, selected the way a deployment selects one — every other
    // moving part is the one that ships.
    const loop = startWorkerLoop({
      executor: handle,
      pollIntervalMs: 20,
      handlers: createHandlers({
        transcriber: fakeTranscriber(SCRIPT),
        generator: fakeGenerator(DRAFT),
        executor: handle,
      }),
    });
    try {
      await waitFor('the pipeline to finish', async () => {
        const rows = await ledger(created.body.id);
        return rows.length === PIPELINE_STEPS.length && rows.every((row) => row.status === 'succeeded');
      });
    } finally {
      loop.stop();
      await loop.done;
      restoreSink();
    }

    const rows = await ledger(created.body.id);
    expect(rows.map((row) => row.step)).toEqual([...PIPELINE_STEPS]);
    for (const row of rows) {
      expect(row.status).toBe('succeeded');
      // One id, from the request that uploaded the file to the last step of its pipeline.
      expect(row.correlation_id).toBe(correlationId);
    }

    // **Every step did real work**, and each says what it cost. Story 3 Ticket 01 replaced the
    // last stub, so there is no longer a row in this ledger that succeeded without doing anything —
    // which is what `/admin/pipeline` stops having to say *not built yet* about. The rows are read
    // by step rather than by position, because §3.4 put `process_audio` ahead of `transcribe` and
    // a position is a fact about the ordered list that belongs to the list.
    const metaOf = (step: string): unknown => rows.find((row) => row.step === step)?.provider_meta;
    expect(metaOf('process_audio')).toMatchObject({ tool: 'fake-copy', costUsd: 0 });
    expect(metaOf('transcribe')).toMatchObject({ model: 'fake', durationSeconds: 372.5 });
    expect(metaOf('generate_draft')).toMatchObject({ model: 'fake', costUsd: 0 });
    expect(metaOf('generate_draft')).not.toHaveProperty('stub');
    expect(metaOf('generate_draft')).toHaveProperty('promptVersion');

    // And the point of the whole chain: the recording has a transcript.
    const transcript = await findTranscriptByRecording(created.body.id, handle);
    expect(transcript?.language).toBe('en');
    expect((await listSegments(transcript?.id ?? '', handle)).map((one) => one.text)).toEqual(
      SCRIPT.segments.map((one) => one.text),
    );

    const mine = captured.filter((line) => line['correlationId'] === correlationId);
    expect(mine.filter((line) => line.message === 'job.claimed')).toHaveLength(PIPELINE_STEPS.length);
    expect(mine.filter((line) => line.message === 'job.succeeded')).toHaveLength(PIPELINE_STEPS.length);
    expect(mine.filter((line) => line.message === 'transcribe.succeeded')).toHaveLength(1);
  }, 180_000);
});
