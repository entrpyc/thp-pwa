import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  API_PREFIX,
  DEFAULT_PREVIEW_START_SECONDS,
  DEFAULT_SOUND_PROFILE,
  PIPELINE_PATH,
  PREVIEW_EXCERPT_SECONDS,
  ROLE,
  SOUND_PROFILE_BOUNDS,
  SOUND_PROFILE_PATH,
  SOUND_PROFILE_PREVIEWS_PATH,
  isApiErrorBody,
  recordingReprocessPath,
  soundProfilePreviewPath,
  type PipelineListPayload,
  type PreviewPayload,
  type ReprocessPayload,
  type SaveSoundProfilePayload,
  type SoundProfilePayload,
  type SoundProfileSettings,
} from '@thp/shared';
import { setLogSink } from '@thp/shared/observability/logger';
import { closeDatabase, createDatabase, insertRecording, type DatabaseHandle } from '@thp/db';
import { UPLOAD_GRANT_SECONDS, mediaStore, mintOriginalKey } from '@thp/media';
import { fakeProcessor } from '../../../worker/src/audio';
import { createHandlers } from '../../../worker/src/handlers';
import { startWorkerLoop } from '../../../worker/src/loop';
import { closeTestDatabase, signedInAccount } from '../support/accounts';

/**
 * The sound profile over HTTP ([3.4.5](docs/project/prd.md)–[3.4.8](docs/project/prd.md)):
 * reading it, saving a version, hearing one before saving, and re-processing one teaching under
 * it — against the real server, the real ledger and the real bucket, with the worker's loop run
 * **in this process** so a preview and a re-process actually finish.
 *
 * The processor is the fake — a copy — because this machine has no encoder; what the chain would
 * have done to the bytes is the worker's unit test's business. What is pinned here is the shape:
 * that a save is a new version and never an edit, that an unchanged save is refused, that a
 * preview comes back as two URLs that genuinely fetch, that a re-process writes the version on
 * the recording and enqueues nothing after itself, and that a member is refused at every door.
 *
 * Every assertion is scoped to the rows this file creates; the suite shares one database.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

let admin: { cookie: string; account: { id: string; displayName: string } };
let member: { cookie: string };
let sql: postgres.Sql;
let handle: DatabaseHandle;
let restoreSink: () => void;

interface Answer<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly code: string | null;
  readonly message: string | null;
}

async function call<T = unknown>(
  path: string,
  cookie: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Answer<T>> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', cookie },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const parsed: unknown = await response.json().catch(() => undefined);
  return {
    status: response.status,
    body: parsed as T,
    code: isApiErrorBody(parsed) ? parsed.error.code : null,
    message: isApiErrorBody(parsed) ? parsed.error.message : null,
  };
}

/** A recording whose original is genuinely in the bucket. */
async function recordingInStore(title: string): Promise<string> {
  const contentType = 'audio/mpeg';
  const key = mintOriginalKey(contentType);
  const url = await mediaStore().presignPut({ key, contentType, expiresInSeconds: UPLOAD_GRANT_SECONDS });
  const put = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: new Uint8Array(new ArrayBuffer(512)).fill(3),
  });
  expect(put.status).toBe(200);
  const row = await insertRecording({ originalMediaKey: key, title, recordedAt: '2026-06-07' }, handle);
  return row.id;
}

/** Run the worker over the shared ledger until this predicate holds, then stop it. */
async function runWorkerUntil(done: () => Promise<boolean>): Promise<void> {
  const loop = startWorkerLoop({
    handlers: createHandlers({ processor: fakeProcessor(), media: mediaStore(), executor: handle }),
    executor: handle,
    pollIntervalMs: 50,
  });
  const deadline = Date.now() + 30_000;
  try {
    while (!(await done())) {
      if (Date.now() > deadline) throw new Error('the worker did not finish in time');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    loop.stop();
    await loop.done;
  }
}

async function jobStatus(id: string): Promise<string | null> {
  const [row] = await sql<{ status: string }[]>`select status::text as status from job where id = ${id}`;
  return row?.status ?? null;
}

beforeAll(async () => {
  Object.assign(process.env, settings);
  restoreSink = setLogSink(() => {});
  sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  handle = createDatabase({ url: databaseUrl, max: 4 });
  admin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'profile-admin');
  member = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'profile-member');
}, 120_000);

afterAll(async () => {
  restoreSink?.();
  await handle?.close();
  await sql?.end({ timeout: 5 });
  await closeTestDatabase();
  await closeDatabase();
});

describe('reading the profile', () => {
  it('answers the version in force and every recording with the version that processed it', async () => {
    const recordingId = await recordingInStore('A teaching to list');
    const answer = await call<SoundProfilePayload>(SOUND_PROFILE_PATH, admin.cookie);
    expect(answer.status).toBe(200);
    expect(answer.body.profile.version).toBeGreaterThanOrEqual(1);
    expect(Object.keys(answer.body.profile.settings).sort()).toEqual(
      ['loudnessTargetLufs', 'noiseReductionDb', 'voiceClarityDb'],
    );
    const listed = answer.body.recordings.find((row) => row.id === recordingId);
    expect(listed).toMatchObject({ hasRendition: false, soundProfileVersion: null, reprocess: null });
  });

  it('is refused to a member at every door', async () => {
    expect((await call(SOUND_PROFILE_PATH, member.cookie)).status).toBe(403);
    expect((await call(SOUND_PROFILE_PATH, member.cookie, { method: 'PUT', body: {} })).status).toBe(403);
    expect((await call(SOUND_PROFILE_PREVIEWS_PATH, member.cookie, { method: 'POST', body: {} })).status).toBe(403);
    expect((await call(recordingReprocessPath('x'), member.cookie, { method: 'POST' })).status).toBe(403);
  });
});

describe('saving a version', () => {
  it('writes the next version, attributed, and refuses the same settings twice', async () => {
    const before = await call<SoundProfilePayload>(SOUND_PROFILE_PATH, admin.cookie);
    const next: SoundProfileSettings = {
      ...before.body.profile.settings,
      noiseReductionDb: (before.body.profile.settings.noiseReductionDb + 1) % (SOUND_PROFILE_BOUNDS.noiseReductionDb.max + 1),
    };

    const saved = await call<SaveSoundProfilePayload>(SOUND_PROFILE_PATH, admin.cookie, {
      method: 'PUT',
      body: { settings: next, note: '  A touch more denoising.  ' },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.profile.version).toBe(before.body.profile.version + 1);
    expect(saved.body.profile.settings).toEqual(next);
    expect(saved.body.profile.createdBy).toBe(admin.account.id);
    expect(saved.body.profile.createdByName).toBe(admin.account.displayName);
    expect(saved.body.profile.note).toBe('A touch more denoising.');

    const again = await call(SOUND_PROFILE_PATH, admin.cookie, { method: 'PUT', body: { settings: next } });
    expect(again.status).toBe(400);
    expect(again.message).toContain(`already the settings of version ${saved.body.profile.version}`);

    // The earlier version is still there, untouched: a save is a row, never an edit.
    const [first] = await sql<{ noise_reduction_db: number }[]>`
      select noise_reduction_db from sound_profile where version = ${before.body.profile.version}
    `;
    expect(first?.noise_reduction_db).toBe(before.body.profile.settings.noiseReductionDb);
  });

  it('refuses a knob out of range, a fraction, and a note too long — naming which', async () => {
    const out = await call(SOUND_PROFILE_PATH, admin.cookie, {
      method: 'PUT',
      body: { settings: { ...DEFAULT_SOUND_PROFILE, loudnessTargetLufs: -8 } },
    });
    expect(out.status).toBe(400);
    expect(out.message).toMatch(/Loudness target/);

    const fraction = await call(SOUND_PROFILE_PATH, admin.cookie, {
      method: 'PUT',
      body: { settings: { ...DEFAULT_SOUND_PROFILE, voiceClarityDb: 1.5 } },
    });
    expect(fraction.status).toBe(400);
    expect(fraction.message).toMatch(/Voice clarity/);

    const note = await call(SOUND_PROFILE_PATH, admin.cookie, {
      method: 'PUT',
      body: { settings: { ...DEFAULT_SOUND_PROFILE, noiseReductionDb: 1 }, note: 'x'.repeat(201) },
    });
    expect(note.status).toBe(400);
    expect(note.message).toMatch(/200 characters/);
  });
});

describe('hearing a change before saving it', () => {
  it('renders two excerpts of the settings sent, and hands back two URLs that fetch', async () => {
    const recordingId = await recordingInStore('A teaching to preview');
    const candidate: SoundProfileSettings = { noiseReductionDb: 30, voiceClarityDb: 6, loudnessTargetLufs: -12 };

    const asked = await call<PreviewPayload>(SOUND_PROFILE_PREVIEWS_PATH, admin.cookie, {
      method: 'POST',
      body: { recordingId, settings: candidate },
    });
    expect(asked.status).toBe(202);
    expect(asked.body.preview).toMatchObject({
      recordingId,
      status: 'pending',
      settings: candidate,
      // No transcript, so the default start stands.
      startSeconds: DEFAULT_PREVIEW_START_SECONDS,
      durationSeconds: PREVIEW_EXCERPT_SECONDS,
      before: null,
      after: null,
    });
    const jobId = asked.body.preview.jobId;

    // A second preview of the same teaching while this one waits is refused, not merged.
    const second = await call(SOUND_PROFILE_PREVIEWS_PATH, admin.cookie, {
      method: 'POST',
      body: { recordingId, settings: DEFAULT_SOUND_PROFILE },
    });
    expect(second.status).toBe(409);
    expect(second.code).toBe('rendition_in_flight');

    await runWorkerUntil(async () => (await jobStatus(jobId)) === 'succeeded');

    const heard = await call<PreviewPayload>(soundProfilePreviewPath(jobId), admin.cookie);
    expect(heard.status).toBe(200);
    expect(heard.body.preview.status).toBe('succeeded');
    expect(heard.body.preview.settings).toEqual(candidate);
    for (const url of [heard.body.preview.before, heard.body.preview.after]) {
      expect(url).toMatch(/^http/);
      const fetched = await fetch(url as string);
      expect(fetched.status).toBe(200);
    }
    expect(heard.body.preview.before).not.toBe(heard.body.preview.after);

    // The preview repointed nothing and saved nothing.
    const [row] = await sql<{ playback_media_key: string | null; sound_profile_version: number | null }[]>`
      select playback_media_key, sound_profile_version from recording where id = ${recordingId}
    `;
    expect(row).toEqual({ playback_media_key: null, sound_profile_version: null });
    const [count] = await sql<{ n: string }[]>`
      select count(*)::text as n from sound_profile
      where noise_reduction_db = 30 and voice_clarity_db = 6 and loudness_target_lufs = -12
    `;
    expect(Number(count?.n)).toBe(0);

    // And it is not a column of the pipeline view.
    const pipeline = await call<PipelineListPayload>(PIPELINE_PATH, admin.cookie);
    const entry = pipeline.body.recordings.find((one) => one.recordingId === recordingId);
    expect(entry?.steps.map((step) => step.step)).not.toContain('preview_audio');
  });

  it('refuses a preview of nothing, of a missing recording, and of a start that is not a count of seconds', async () => {
    expect((await call(SOUND_PROFILE_PREVIEWS_PATH, admin.cookie, { method: 'POST', body: {} })).status).toBe(400);

    const missing = await call(SOUND_PROFILE_PREVIEWS_PATH, admin.cookie, {
      method: 'POST',
      body: { recordingId: '00000000-0000-4000-8000-000000000000', settings: DEFAULT_SOUND_PROFILE },
    });
    expect(missing.status).toBe(404);

    const recordingId = await recordingInStore('A teaching to start late');
    const late = await call(SOUND_PROFILE_PREVIEWS_PATH, admin.cookie, {
      method: 'POST',
      body: { recordingId, settings: DEFAULT_SOUND_PROFILE, startSeconds: -1 },
    });
    expect(late.status).toBe(400);
    expect(late.message).toMatch(/whole number of seconds/);

    expect((await call(soundProfilePreviewPath('00000000-0000-4000-8000-000000000000'), admin.cookie)).status).toBe(404);
  });
});

describe('re-processing one teaching', () => {
  it('produces the rendition under the version in force, writes the version, and chains nothing', async () => {
    const recordingId = await recordingInStore('A teaching to re-process');
    const profile = await call<SoundProfilePayload>(SOUND_PROFILE_PATH, admin.cookie);

    const asked = await call<ReprocessPayload>(recordingReprocessPath(recordingId), admin.cookie, { method: 'POST' });
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({ recordingId, attempt: 1 });

    // Pressing again while it waits is refused rather than answered with the first job.
    const twice = await call(recordingReprocessPath(recordingId), admin.cookie, { method: 'POST' });
    expect(twice.status).toBe(409);
    expect(twice.code).toBe('rendition_in_flight');

    await runWorkerUntil(async () => (await jobStatus(asked.body.jobId)) === 'succeeded');

    const [row] = await sql<{ playback_media_key: string | null; sound_profile_version: number | null }[]>`
      select playback_media_key, sound_profile_version from recording where id = ${recordingId}
    `;
    expect(row?.playback_media_key).toMatch(/^playback\//);
    expect(row?.sound_profile_version).toBe(profile.body.profile.version);

    const steps = await sql<{ step: string }[]>`
      select step::text as step from job where recording_id = ${recordingId} order by enqueued_at
    `;
    expect(steps.map((one) => one.step)).toEqual(['reprocess_audio']);

    const listed = await call<SoundProfilePayload>(SOUND_PROFILE_PATH, admin.cookie);
    const entry = listed.body.recordings.find((one) => one.id === recordingId);
    expect(entry).toMatchObject({
      hasRendition: true,
      soundProfileVersion: profile.body.profile.version,
      reprocess: { status: 'succeeded', attempt: 1, error: null },
    });
  });

  it('answers not found for a recording that is not there', async () => {
    const answer = await call(recordingReprocessPath('00000000-0000-4000-8000-000000000000'), admin.cookie, { method: 'POST' });
    expect(answer.status).toBe(404);
  });
});
