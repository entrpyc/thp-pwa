import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  ACCEPTED_AUDIO_FORMATS,
  API_PREFIX,
  CORRELATION_ID_HEADER,
  NOT_STARTED,
  PIPELINE_PATH,
  PIPELINE_STEPS,
  RECORDINGS_PATH,
  RECORDING_UPLOADS_PATH,
  ROLE,
  isApiErrorBody,
  recordingRerunPath,
  type PipelineListPayload,
  type PipelineStep,
  type RecordingPipeline,
  type RecordingSummary,
  type UploadGrantPayload,
} from '@thp/shared';
import { setLogSink, type LogLine } from '@thp/shared/observability/logger';
import {
  closeDatabase,
  createDatabase,
  enqueueJob,
  failJob,
  findTranscriptByRecording,
  listSegments,
  type DatabaseHandle,
} from '@thp/db';
import { startWorkerLoop } from '../../../worker/src/loop';
import { createHandlers } from '../../../worker/src/handlers';
import { fakeTranscriber, type FakeScript } from '../../../worker/src/asr';
import { fakeGenerator } from '../../../worker/src/generate';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';
import { logOffset, waitForLogLines } from '../support/log-reader';

/**
 * `GET /api/v1/pipeline` and `POST /api/v1/recordings/:id/rerun`, over HTTP against the real
 * server and the real ledger.
 *
 * The two halves are read together because they are read together on screen: what the pipeline is
 * doing, and the one control that makes it do a step again. Three properties carry the suite, and
 * each is one the append-only ledger makes non-obvious:
 *
 * 1. **A re-run has no precondition on the steps before it.** Running `generate_draft` for a
 *    recording whose `transcribe` failed is docs/project/prd.md 3.5.8's escape hatch — the admin
 *    read the low-confidence transcript and judged it usable — not a mistake to guard against.
 * 2. **A re-run of `transcribe` re-runs what follows it, on success.** 3.21.2.4's "without
 *    re-running the whole pipeline" is satisfied by being able to start anywhere, not by severing
 *    the chain: a fresh transcript makes the existing draft wrong.
 * 3. **Pressing it twice is harmless.** The partial unique index refuses the second row, the
 *    enqueue reads the first one back, and both calls are answered with the same job.
 *
 * The suite shares one database with the rest of the run, so every assertion is scoped to the
 * recordings this file creates. Asserting a total would be asserting what the rest of the run
 * happened to do that second.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const logPath = inject('apiLogPath');
const settings = inject('mediaSettings');

const PIPELINE_URL = `${baseUrl}${API_PREFIX}${PIPELINE_PATH}`;
const UPLOADS_URL = `${baseUrl}${API_PREFIX}${RECORDING_UPLOADS_PATH}`;
const RECORDINGS_URL = `${baseUrl}${API_PREFIX}${RECORDINGS_PATH}`;

let admin: TestAccount;
let adminCookie: string;
let member: TestAccount;
let memberCookie: string;
let sql: postgres.Sql;
let handle: DatabaseHandle;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly body: T;
}

async function call<T>(
  url: string,
  init: RequestInit & { cookie?: string; correlationId?: string } = {},
): Promise<Answer<T>> {
  const { cookie, correlationId, ...rest } = init;
  const response = await fetch(url, {
    ...rest,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
      ...(correlationId === undefined ? {} : { [CORRELATION_ID_HEADER]: correlationId }),
      ...rest.headers,
    },
  });
  const body: unknown = await response.json().catch(() => undefined);
  return {
    status: response.status,
    code: isApiErrorBody(body) ? body.error.code : null,
    body: body as T,
  };
}

function bytes(size: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(size)).fill(7);
}

/** A recording with a real object behind it, created through the real HTTP flow. */
async function newRecording(title: string, recordedAt = '2026-04-19'): Promise<RecordingSummary> {
  const grant = await call<UploadGrantPayload>(UPLOADS_URL, {
    method: 'POST',
    cookie: adminCookie,
    body: JSON.stringify({
      filename: 'teaching.mp3',
      contentType: ACCEPTED_AUDIO_FORMATS.mp3,
      size: 256,
    }),
  });
  expect(grant.status).toBe(200);
  const put = await fetch(grant.body.url, {
    method: 'PUT',
    headers: { 'content-type': grant.body.contentType },
    body: bytes(256),
  });
  expect(put.status).toBe(200);

  const created = await call<RecordingSummary>(RECORDINGS_URL, {
    method: 'POST',
    cookie: adminCookie,
    body: JSON.stringify({ key: grant.body.key, title, recordedAt }),
  });
  expect(created.status).toBe(201);
  return created.body;
}

/** This recording's row of the pipeline read, as an admin sees it. */
async function pipelineOf(recordingId: string): Promise<RecordingPipeline> {
  const answer = await call<PipelineListPayload>(PIPELINE_URL, { cookie: adminCookie });
  expect(answer.status).toBe(200);
  const found = answer.body.recordings.find((one) => one.recordingId === recordingId);
  if (!found) throw new Error(`no pipeline row for recording ${recordingId}`);
  return found;
}

function stepOf(row: RecordingPipeline, step: PipelineStep) {
  const found = row.steps.find((one) => one.step === step);
  if (!found) throw new Error(`no ${step} in the answer`);
  return found;
}

async function rerun(
  recordingId: string,
  step: string,
  options: { cookie?: string; correlationId?: string } = {},
): Promise<Answer<{ jobId: string; attempt: number; step: string }>> {
  return call(`${baseUrl}${API_PREFIX}${recordingRerunPath(recordingId)}`, {
    method: 'POST',
    ...(options.cookie === undefined ? { cookie: adminCookie } : { cookie: options.cookie }),
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
    body: JSON.stringify({ step }),
  });
}

async function ledgerRows(
  recordingId: string,
): Promise<{ step: string; status: string; attempt: number }[]> {
  return (await sql<{ step: string; status: string; attempt: number }[]>`
    select step::text as step, status::text as status, attempt
    from job where recording_id = ${recordingId} order by enqueued_at, id
  `) as unknown as { step: string; status: string; attempt: number }[];
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

  const signedInAdmin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'pipeline-api-admin');
  admin = signedInAdmin.account;
  adminCookie = signedInAdmin.cookie;

  const signedInMember = await signedInAccount(
    baseUrl,
    databaseUrl,
    ROLE.member,
    'pipeline-api-member',
  );
  member = signedInMember.account;
  memberCookie = signedInMember.cookie;
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await closeDatabase();
  await sql?.end({ timeout: 5 });
  await closeTestDatabase();
});

// =================================================================================================

describe('who may read the pipeline', () => {
  it('refuses a member, and refuses an anonymous caller', async () => {
    // The API refuses; the panel only hides. A member with a forged navigation gets the same
    // answer as a member with a browser — which is the property the page gate does not hold.
    const asMember = await call(PIPELINE_URL, { cookie: memberCookie });
    expect(asMember.status).toBe(403);
    expect(asMember.code).toBe('forbidden');
    expect(member.email.length).toBeGreaterThan(0);

    const anonymous = await call(PIPELINE_URL);
    expect(anonymous.status).toBe(401);
    expect(anonymous.code).toBe('unauthenticated');
  });

  it('refuses a member the re-run independently of the read', async () => {
    const recording = await newRecording('Refused re-run');

    const refused = await rerun(recording.id, 'transcribe', { cookie: memberCookie });
    expect(refused.status).toBe(403);
    expect(refused.code).toBe('forbidden');

    // And nothing was queued by the refusal: the recording still has only its first job.
    expect(await ledgerRows(recording.id)).toHaveLength(1);
  }, 90_000);
});

describe('what the read answers with', () => {
  it('reports a freshly finalised recording as transcribe waiting, generate_draft not started', async () => {
    const recording = await newRecording('Freshly finalised');

    const row = await pipelineOf(recording.id);
    expect(row.title).toBe('Freshly finalised');
    expect(row.steps.map((one) => one.step)).toEqual([...PIPELINE_STEPS]);
    expect(stepOf(row, 'transcribe').status).toBe('pending');
    expect(stepOf(row, 'transcribe').attempt).toBe(1);
    expect(stepOf(row, 'transcribe').enqueuedAt).not.toBeNull();
    // Not absent, and not a failure: the chain has not reached it yet.
    expect(stepOf(row, 'generate_draft').status).toBe(NOT_STARTED);
    expect(stepOf(row, 'generate_draft').attempt).toBeNull();
  }, 90_000);

  it('names the reason a step failed, in the row', async () => {
    const recording = await newRecording('A failed step');
    const [waiting] = await ledgerRows(recording.id);
    expect(waiting?.status).toBe('pending');

    const job = await sql<{ id: string }[]>`
      select id from job where recording_id = ${recording.id} and step = 'transcribe'
    `;
    await failJob(job[0]?.id as string, 'Deepgram refused the audio with HTTP 415', handle);

    const step = stepOf(await pipelineOf(recording.id), 'transcribe');
    expect(step.status).toBe('failed');
    // The whole point of the screen: why, in the same place as that.
    expect(step.error).toBe('Deepgram refused the audio with HTTP 415');
    expect(step.finishedAt).not.toBeNull();
  }, 90_000);

  it('carries no provider detail across the wire, only whether a stub produced it', async () => {
    const recording = await newRecording('Stub marker');

    const answer = await call<PipelineListPayload>(PIPELINE_URL, { cookie: adminCookie });
    const row = answer.body.recordings.find((one) => one.recordingId === recording.id);
    // `provider_meta` is the worker's business and stays behind the API; what the screen needs is
    // the one question it asks of it.
    expect(Object.keys(row?.steps[0] ?? {}).sort()).toEqual([
      'attempt',
      'enqueuedAt',
      'error',
      'finishedAt',
      'startedAt',
      'status',
      'step',
      'stub',
    ]);
  }, 90_000);

  it('comes back in the same order as the recordings list', async () => {
    await newRecording('Ordering, older', '2024-02-01');
    await newRecording('Ordering, newer', '2024-02-02');

    const pipeline = await call<PipelineListPayload>(PIPELINE_URL, { cookie: adminCookie });
    const recordings = await call<{ recordings: readonly RecordingSummary[] }>(RECORDINGS_URL, {
      cookie: adminCookie,
    });

    // Both queries order by the date recorded, so the console has **one** answer to "what is most
    // recent" rather than one per panel — and neither client re-sorts what it was sent.
    expect(pipeline.body.recordings.map((one) => one.recordingId)).toEqual(
      recordings.body.recordings.map((one) => one.id),
    );
    expect(pipeline.body.recordings.length).toBeGreaterThan(1);
  }, 120_000);

  it('carries no speaker in the recording payload, and serves no segment anywhere', async () => {
    const recordings = await call<{ recordings: readonly RecordingSummary[] }>(RECORDINGS_URL, {
      cookie: adminCookie,
    });
    const summary = recordings.body.recordings[0];
    expect(summary).toBeDefined();

    // The column exists and **nothing reads it**: no payload carries it, and there is no route
    // that serves a segment at all. `0` and `1` stay `0` and `1` until something is built to name
    // them, which is no ticket in this epic.
    expect(Object.keys(summary ?? {}).sort()).toEqual([
      'createdAt',
      'description',
      // Group 4's, and still not a speaker: whether the teaching has any approved scripture
      // reference, which is what decides whether the recording page draws the tab.
      'hasScripture',
      'id',
      'originalMediaKey',
      'publishedAt',
      'recordedAt',
      // Story 6's, and still not a speaker: the payload gained the series a recording is in and
      // nothing else.
      'series',
      'summary',
      // Tags ([4.7](docs/project/prd.md)), and still not a speaker: hand-applied labels.
      'tags',
      'title',
    ]);

    const pipeline = await call<PipelineListPayload>(PIPELINE_URL, { cookie: adminCookie });
    expect(JSON.stringify(pipeline.body)).not.toContain('speaker');
  }, 120_000);

  it('logs the read with actor, action and target', async () => {
    const offset = logOffset(logPath);
    const correlationId = `pipeline-read-${Date.now().toString(36)}`;

    await call(PIPELINE_URL, { cookie: adminCookie, correlationId });

    const lines = await waitForLogLines(logPath, offset, (found) =>
      found.some(
        (line) => line.message === 'pipeline.read' && line['correlationId'] === correlationId,
      ),
    );
    const read = lines.find((line) => line.message === 'pipeline.read');
    expect(read?.['actorId']).toBe(admin.id);
    expect(read?.['action']).toBe('pipeline.read');
  }, 90_000);
});

describe('running one step again', () => {
  it('enqueues a fresh attempt of the step it names', async () => {
    const recording = await newRecording('Re-run transcribe');
    // Take the first attempt out of flight, so the re-run is a genuinely new row rather than the
    // no-op the partial unique index would otherwise make it.
    const job = await sql<{ id: string }[]>`
      select id from job where recording_id = ${recording.id} and step = 'transcribe'
    `;
    await failJob(job[0]?.id as string, 'the provider refused the audio', handle);

    const answer = await rerun(recording.id, 'transcribe');
    expect(answer.status).toBe(200);
    expect(answer.body.step).toBe('transcribe');
    expect(answer.body.attempt).toBe(2);

    // The ledger is append-only, so the failure is still readable and the screen shows the new
    // attempt — a re-run is a number going up, not a status reset.
    const rows = await ledgerRows(recording.id);
    expect(rows.map((row) => [row.step, row.status, row.attempt])).toEqual([
      ['transcribe', 'failed', 1],
      ['transcribe', 'pending', 2],
    ]);
    const step = stepOf(await pipelineOf(recording.id), 'transcribe');
    expect(step.status).toBe('pending');
    expect(step.attempt).toBe(2);
  }, 90_000);

  it('has no precondition on the steps before it', async () => {
    const recording = await newRecording('Generate from a failed transcript');
    const job = await sql<{ id: string }[]>`
      select id from job where recording_id = ${recording.id} and step = 'transcribe'
    `;
    // The confidence gate's failure: the transcript was written, and the job failed on purpose.
    await failJob(
      job[0]?.id as string,
      'the transcript was written, but its confidence of 0.41 is below the threshold of 0.6',
      handle,
    );

    // docs/project/prd.md 3.5.8's escape hatch: the admin read it, judged it usable, and runs
    // generation directly. Nothing about `transcribe` having failed refuses this.
    const answer = await rerun(recording.id, 'generate_draft');
    expect(answer.status).toBe(200);

    const row = await pipelineOf(recording.id);
    expect(stepOf(row, 'transcribe').status).toBe('failed');
    expect(stepOf(row, 'generate_draft').status).toBe('pending');
    expect(stepOf(row, 'generate_draft').attempt).toBe(1);
  }, 90_000);

  it('is harmless pressed twice, and answers both calls with the same job', async () => {
    const recording = await newRecording('Pressed twice');

    // Both calls name a step already unfinished — the first is the recording's own first job.
    const first = await rerun(recording.id, 'transcribe');
    const second = await rerun(recording.id, 'transcribe');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Not a conflict. The database already resolved it, and the API does not invent a failure on
    // top of an answer that is correct for both callers.
    expect(second.body.jobId).toBe(first.body.jobId);

    const unfinished = await ledgerRows(recording.id);
    expect(unfinished.filter((row) => row.status === 'pending')).toHaveLength(1);
    expect(unfinished).toHaveLength(1);
  }, 90_000);

  it('re-runs what follows it, on success', async () => {
    const recording = await newRecording('Chain after a re-run', '2026-04-21');
    const job = await sql<{ id: string }[]>`
      select id from job where recording_id = ${recording.id} and step = 'transcribe'
    `;
    await failJob(job[0]?.id as string, 'the provider refused the audio', handle);

    const answer = await rerun(recording.id, 'transcribe');
    expect(answer.status).toBe(200);
    expect(answer.body.attempt).toBe(2);

    const restoreSink = setLogSink((): void => {});
    const loop = startWorkerLoop({
      executor: handle,
      pollIntervalMs: 20,
      handlers: createHandlers({
        transcriber: fakeTranscriber(DIARISED_SCRIPT),
        generator: fakeGenerator(DRAFT),
        executor: handle,
      }),
    });
    try {
      await waitFor('the re-run to chain forward and the successor to run', async () => {
        const rows = await ledgerRows(recording.id);
        // Waiting for the successor to *finish*, not merely to appear: stopping the loop the
        // moment the row exists would leave the assertion below racing the worker.
        return rows.some((row) => row.step === 'generate_chapters' && row.status === 'succeeded');
      });
    } finally {
      loop.stop();
      await loop.done;
      restoreSink();
    }

    // The chain rule Ticket 02 built, unchanged. 3.21.2.4's "without re-running the whole
    // pipeline" is satisfied by being able to start *anywhere*, not by severing the chain — a
    // fresh transcript makes the existing draft wrong.
    const rows = await ledgerRows(recording.id);
    // Every step behind it, not only the next one: the chain runs forward to its end, so a fresh
    // transcript regenerates the chapters cut from the old words too
    // ([3.22.1](docs/project/prd.md)).
    expect(rows.map((row) => [row.step, row.status, row.attempt])).toEqual([
      ['transcribe', 'failed', 1],
      ['transcribe', 'succeeded', 2],
      ['generate_draft', 'succeeded', 1],
      ['generate_chapters', 'succeeded', 1],
    ]);
  }, 180_000);

  it('runs only the step it names when that step is last in the chain', async () => {
    const recording = await newRecording('Generate only', '2026-04-22');
    const job = await sql<{ id: string }[]>`
      select id from job where recording_id = ${recording.id} and step = 'transcribe'
    `;
    await failJob(job[0]?.id as string, 'below the confidence threshold', handle);

    // `generate_chapters` is the last step of the chain ([3.22.1](docs/project/prd.md)), which is
    // why it is the one asked for by name here. Nothing runs it: what is under test is the enqueue.
    await rerun(recording.id, 'generate_chapters');

    // Re-running the last step queues that step and nothing else — nothing before it is re-queued
    // behind it, because the chain runs forward and never back.
    const rows = await ledgerRows(recording.id);
    expect(rows.filter((row) => row.step === 'transcribe')).toHaveLength(1);
    expect(rows.filter((row) => row.step === 'generate_chapters')).toHaveLength(1);
    expect(rows.filter((row) => row.step === 'generate_draft')).toHaveLength(0);
  }, 120_000);

  it('answers not_found for an unknown recording and invalid_input for a value that is not a step', async () => {
    const missing = await rerun('00000000-0000-0000-0000-000000000000', 'transcribe');
    expect(missing.status).toBe(404);
    expect(missing.code).toBe('not_found');

    const recording = await newRecording('Bad step');
    for (const value of ['process_audio', '', 'TRANSCRIBE']) {
      const refused = await rerun(recording.id, value);
      expect(refused.status, value).toBe(400);
      expect(refused.code, value).toBe('invalid_input');
    }
    // And a body that is not an object at all.
    const empty = await call(`${baseUrl}${API_PREFIX}${recordingRerunPath(recording.id)}`, {
      method: 'POST',
      cookie: adminCookie,
      body: 'not json',
    });
    expect(empty.status).toBe(400);
    expect(empty.code).toBe('invalid_input');

    expect(await ledgerRows(recording.id)).toHaveLength(1);
  }, 120_000);

  it('logs the re-run with actor, action, target and the step', async () => {
    const recording = await newRecording('Logged re-run');
    const offset = logOffset(logPath);
    const correlationId = `pipeline-rerun-${Date.now().toString(36)}`;

    await rerun(recording.id, 'transcribe', { correlationId });

    const lines = await waitForLogLines(logPath, offset, (found) =>
      found.some(
        (line) => line.message === 'pipeline.rerun' && line['correlationId'] === correlationId,
      ),
    );
    const line = lines.find((entry) => entry.message === 'pipeline.rerun');
    expect(line?.['actorId']).toBe(admin.id);
    expect(line?.['actorEmail']).toBe(admin.email);
    expect(line?.['action']).toBe('pipeline.rerun');
    expect(line?.['target']).toBe(`recording:${recording.id}`);
    expect(line?.['step']).toBe('transcribe');
  }, 90_000);

  it('carries the request’s correlation id onto the job it queued', async () => {
    const recording = await newRecording('Traceable re-run');
    const job = await sql<{ id: string }[]>`
      select id from job where recording_id = ${recording.id} and step = 'transcribe'
    `;
    await failJob(job[0]?.id as string, 'refused', handle);

    const correlationId = `rerun-trace-${Date.now().toString(36)}`;
    const answer = await rerun(recording.id, 'transcribe', { correlationId });

    // The re-run goes through the queue port like every other enqueue, so the row carries the id
    // of the request that caused it across the process boundary.
    const rows = await sql<{ correlation_id: string }[]>`
      select correlation_id from job where id = ${answer.body.jobId}
    `;
    expect(rows[0]?.correlation_id).toBe(correlationId);
  }, 90_000);
});

/** A diarised script: two voices, and one sentence the provider attributed to nobody. */
const DIARISED_SCRIPT: FakeScript = {
  language: 'en',
  confidence: 0.94,
  durationSeconds: 372.5,
  segments: [
    { startMs: 0, endMs: 4120, text: "Good morning, and welcome to this morning's teaching.", speaker: 0 },
    { startMs: 4120, endMs: 9880, text: 'We are picking up where we left off last week.', speaker: 0 },
    { startMs: 9880, endMs: 15_340, text: 'Can I ask something about the second verse?', speaker: 1 },
    { startMs: 15_340, endMs: 19_000, text: 'Yes, of course — go ahead.', speaker: 0 },
    { startMs: 19_000, endMs: 22_400, text: 'Something nobody was given.', speaker: null },
  ],
};

/** What the drafting provider would have written. The second of two fakes in this suite. */
const DRAFT = {
  summary: 'The teaching stays with the second chapter throughout.',
  description: 'A close reading of the second chapter.',
};

describe('upload, transcribe, generate_draft', () => {
  it('leaves both steps succeeded, neither of them a stub, and segments carrying speakers', async () => {
    const captured: LogLine[] = [];
    const restoreSink = setLogSink((line) => captured.push(line));

    const recording = await newRecording('The whole pipeline', '2026-04-20');

    // The real loop, against the real ledger and the real object store. Nothing told it about this
    // upload; the transcriber is the fake, selected the way a deployment selects one.
    const loop = startWorkerLoop({
      executor: handle,
      pollIntervalMs: 20,
      handlers: createHandlers({
        transcriber: fakeTranscriber(DIARISED_SCRIPT),
        generator: fakeGenerator(DRAFT),
        executor: handle,
      }),
    });
    try {
      await waitFor('the pipeline to finish', async () => {
        const rows = await ledgerRows(recording.id);
        return (
          rows.length === PIPELINE_STEPS.length && rows.every((row) => row.status === 'succeeded')
        );
      });
    } finally {
      loop.stop();
      await loop.done;
      restoreSink();
    }

    const row = await pipelineOf(recording.id);
    expect(stepOf(row, 'transcribe').status).toBe('succeeded');
    expect(stepOf(row, 'generate_draft').status).toBe('succeeded');
    // **Neither is a stub any more.** Story 3 Ticket 01 replaced the last one, so the panel stops
    // having to say *not built yet* about anything — a succeeded row here means the step genuinely
    // ran. The screen keeps the ability to say it, for rows written while the stub existed.
    expect(stepOf(row, 'transcribe').stub).toBe(false);
    expect(stepOf(row, 'generate_draft').stub).toBe(false);

    const transcript = await findTranscriptByRecording(recording.id, handle);
    const segments = await listSegments(transcript?.id ?? '', handle);
    // The provider's indices, persisted as they came. `0` and `1` stay `0` and `1`.
    expect(segments.map((one) => one.speaker)).toEqual([0, 0, 1, 0, null]);
    expect(captured.find((line) => line.message === 'transcribe.succeeded')?.['speakers']).toBe(2);
  }, 180_000);
});
