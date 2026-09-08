import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  createDatabase,
  enqueueJob,
  findRecordingById,
  insertRecording,
  insertSoundProfileVersion,
  insertUser,
  runMigrations,
  type DatabaseHandle,
  type JobRow,
} from '@thp/db';
import { UPLOAD_GRANT_SECONDS, mediaStore, mintOriginalKey, type MediaStore } from '@thp/media';
import { ACCEPTED_AUDIO_FORMATS, DEFAULT_SOUND_PROFILE, type JobStep } from '@thp/shared';
import { setLogSink } from '@thp/shared/observability/logger';
import { fakeProcessor, type AudioProcessRequest, type AudioProcessor } from '../../src/audio';
import { createHandlers } from '../../src/handlers';
import { runJob } from '../../src/run-job';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * The three audio steps against a real database and the real object store, with the processor
 * faked by configuration — a `AudioProcessor` handed in, exactly as the transcriber is.
 *
 * What is pinned is what the sound profile changed about the step
 * ([3.4.5](docs/project/prd.md)–[3.4.7](docs/project/prd.md)): the profile in force reaches the
 * processor; the version that processed a recording is written beside its rendition; a re-run
 * outside the chain writes a new rendition under the new version and enqueues nothing; and a
 * preview leaves two objects and repoints nothing. The bytes are the fake's copies, because the
 * suite's machines have no encoder — what the filter chain would have done is pinned by the unit
 * test over the command line.
 */

const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const AUDIO = ACCEPTED_AUDIO_FORMATS.mp3;

let target: ThrowawayDatabase;
let sql: postgres.Sql;
let handle: DatabaseHandle;
let store: MediaStore;
let adminId: string;
let recordings = 0;

/** A processor that records what it was asked, and copies like the fake. */
function recordingProcessor(): AudioProcessor & { readonly requests: AudioProcessRequest[] } {
  const inner = fakeProcessor();
  const requests: AudioProcessRequest[] = [];
  return {
    name: 'fake-copy',
    requests,
    outputFor: (extension, contentType) => inner.outputFor(extension, contentType),
    async process(request) {
      requests.push(request);
      await inner.process(request);
    },
  };
}

async function uploadedObject(): Promise<string> {
  const key = mintOriginalKey(AUDIO);
  const url = await store.presignPut({ key, contentType: AUDIO, expiresInSeconds: UPLOAD_GRANT_SECONDS });
  const put = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': AUDIO },
    body: new Uint8Array(new ArrayBuffer(256)).fill(9),
  });
  expect(put.status).toBe(200);
  return key;
}

async function claimedJob(step: JobStep, payload?: unknown): Promise<JobRow> {
  recordings += 1;
  const recording = await insertRecording(
    { originalMediaKey: await uploadedObject(), title: `Teaching ${recordings}`, recordedAt: '2026-06-07' },
    handle,
  );
  return claimedJobFor(recording.id, step, payload);
}

async function claimedJobFor(recordingId: string, step: JobStep, payload?: unknown): Promise<JobRow> {
  const job = await enqueueJob(
    { recordingId, step, correlationId: `audio-${recordingId}-${step}`, payload },
    handle,
  );
  await sql`update job set status = 'running', started_at = now() where id = ${job.id}`;
  return { ...job, status: 'running', startedAt: new Date() };
}

async function ledger(recordingId: string): Promise<{ step: string; status: string; provider_meta: Record<string, unknown> | null }[]> {
  return (await sql`
    select step::text as step, status::text as status, provider_meta
    from job where recording_id = ${recordingId} order by enqueued_at, id
  `) as unknown as { step: string; status: string; provider_meta: Record<string, unknown> | null }[];
}

beforeAll(async () => {
  Object.assign(process.env, settings);
  store = mediaStore();

  target = await createThrowawayDatabase(databaseUrl, 'process_audio');
  await runMigrations({ url: target.url });
  sql = postgres(target.url, { max: 4, onnotice: () => {} });
  handle = createDatabase({ url: target.url, max: 6 });

  const admin = await insertUser(
    { email: 'profile-admin@example.test', passwordHash: 'not-a-real-hash', displayName: 'Profile Admin', role: 'admin' },
    handle,
  );
  adminId = admin.id;
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await sql?.end({ timeout: 5 });
  await target?.drop();
}, 60_000);

beforeEach(() => {
  const restore = setLogSink(() => {});
  return () => restore();
});

describe('process_audio under the profile in force', () => {
  it('hands the processor the current settings and writes the version beside the rendition', async () => {
    const processor = recordingProcessor();
    const job = await claimedJob('process_audio');

    await runJob(job, createHandlers({ processor, media: store, executor: handle }), { executor: handle });

    expect(processor.requests).toHaveLength(1);
    expect(processor.requests[0]?.profile).toEqual(DEFAULT_SOUND_PROFILE);
    expect(processor.requests[0]?.excerpt).toBeUndefined();

    const row = await findRecordingById(job.recordingId, handle);
    expect(row?.playbackMediaKey).toMatch(/^playback\//);
    expect(row?.soundProfileVersion).toBe(1);

    const rows = await ledger(job.recordingId);
    expect(rows.map((one) => [one.step, one.status])).toEqual([
      ['process_audio', 'succeeded'],
      ['transcribe', 'pending'],
    ]);
    expect(rows[0]?.provider_meta?.['soundProfileVersion']).toBe(1);
  });
});

describe('reprocess_audio', () => {
  it('writes a new rendition under the newest version and enqueues nothing behind it', async () => {
    const first = recordingProcessor();
    const job = await claimedJob('process_audio');
    await runJob(job, createHandlers({ processor: first, media: store, executor: handle }), { executor: handle });
    const before = await findRecordingById(job.recordingId, handle);

    const saved = await insertSoundProfileVersion(
      { settings: { noiseReductionDb: 20, voiceClarityDb: 0, loudnessTargetLufs: -18 }, note: null, createdBy: adminId },
      handle,
    );
    expect(saved.version).toBe(2);

    const second = recordingProcessor();
    const rerun = await claimedJobFor(job.recordingId, 'reprocess_audio');
    await runJob(rerun, createHandlers({ processor: second, media: store, executor: handle }), { executor: handle });

    expect(second.requests[0]?.profile).toEqual({ noiseReductionDb: 20, voiceClarityDb: 0, loudnessTargetLufs: -18 });

    const after = await findRecordingById(job.recordingId, handle);
    expect(after?.soundProfileVersion).toBe(2);
    expect(after?.playbackMediaKey).not.toBe(before?.playbackMediaKey);
    // The superseded rendition is still there, unreferenced — replaced artwork's price.
    expect(await store.head(before?.playbackMediaKey ?? '')).not.toBeNull();
    // The original is untouched.
    expect(after?.originalMediaKey).toBe(before?.originalMediaKey);

    const rows = await ledger(job.recordingId);
    expect(rows.map((one) => [one.step, one.status])).toEqual([
      ['process_audio', 'succeeded'],
      ['transcribe', 'pending'],
      ['reprocess_audio', 'succeeded'],
    ]);
  });
});

describe('preview_audio', () => {
  it('renders the excerpt twice — plain, then under the payload — and repoints nothing', async () => {
    const processor = recordingProcessor();
    const candidate = { noiseReductionDb: 25, voiceClarityDb: 6, loudnessTargetLufs: -14 };
    const job = await claimedJob('preview_audio', { settings: candidate, startSeconds: 42 });

    await runJob(job, createHandlers({ processor, media: store, executor: handle }), { executor: handle });

    expect(processor.requests.map((request) => request.profile)).toEqual([null, candidate]);
    for (const request of processor.requests) {
      expect(request.excerpt).toEqual({ startSeconds: 42, durationSeconds: 30 });
    }

    const rows = await ledger(job.recordingId);
    expect(rows.map((one) => [one.step, one.status])).toEqual([['preview_audio', 'succeeded']]);
    const meta = rows[0]?.provider_meta ?? {};
    expect(meta['beforeKey']).toMatch(/^preview\/.*-before\.mp3$/);
    expect(meta['afterKey']).toMatch(/^preview\/.*-after\.mp3$/);
    expect(await store.head(String(meta['beforeKey']))).not.toBeNull();
    expect(await store.head(String(meta['afterKey']))).not.toBeNull();

    const row = await findRecordingById(job.recordingId, handle);
    expect(row?.playbackMediaKey).toBeNull();
    expect(row?.soundProfileVersion).toBeNull();
  });

  it('fails naming the payload when the row carries settings the profile would refuse', async () => {
    const processor = recordingProcessor();
    const job = await claimedJob('preview_audio', {
      settings: { noiseReductionDb: 12, voiceClarityDb: 3, loudnessTargetLufs: -5 },
      startSeconds: 0,
    });

    await runJob(job, createHandlers({ processor, media: store, executor: handle }), { executor: handle });

    expect(processor.requests).toHaveLength(0);
    const [row] = await sql<{ status: string; error: string }[]>`select status::text as status, error from job where id = ${job.id}`;
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatch(/Loudness target/);
  });
});
