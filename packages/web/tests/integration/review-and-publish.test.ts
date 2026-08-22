import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  ACCEPTED_AUDIO_FORMATS,
  API_PREFIX,
  PIPELINE_STEPS,
  RECORDINGS_PATH,
  RECORDING_UPLOADS_PATH,
  REVIEW_KINDS,
  REVIEWS_PATH,
  ROLE,
  recordingPublishPath,
  recordingUnpublishPath,
  reviewPath,
  reviewRegeneratePath,
  type RecordingListPayload,
  type RecordingSummary,
  type RecordingView,
  type RegenerateReviewPayload,
  type ReviewItemView,
  type ReviewListPayload,
  type UploadGrantPayload,
} from '@thp/shared';
import { createDatabase, type DatabaseHandle } from '@thp/db';
import { startWorkerLoop } from '../../../worker/src/loop';
import { createHandlers } from '../../../worker/src/handlers';
import { fakeTranscriber, type FakeScript } from '../../../worker/src/asr';
import { fakeGenerator } from '../../../worker/src/generate';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';

/**
 * **The story, end to end** — docs/epics/epic-core-listening/prd.md § Epic flows' review path.
 *
 * Upload → transcribe → generate_draft → queue → approve both kinds → publish, and then read the
 * result back **as a member**, which is the only reading that proves anything. Then the other half
 * of the flow: regenerate with a steer, approve the second draft, and confirm it is the second
 * draft's text that went live.
 *
 * Everything here is the artefact that ships except the two providers, and those are faked the way
 * a deployment selects one — by configuration, through the same port. The API is reached over HTTP,
 * the worker is the real loop against the real ledger and the real object store, and nothing tells
 * the worker about the upload.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const mediaSettings = inject('mediaSettings');

/** What the transcription provider would have said. */
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

/** What the drafting provider would have written. */
const DRAFT = {
  summary: 'The teaching stays with the second chapter of the letter throughout.',
  description: 'A close reading of the letter’s second chapter.',
};

let admin: TestAccount;
let adminCookie: string;
let member: TestAccount;
let memberCookie: string;
let handle: DatabaseHandle;
let sql: postgres.Sql;

async function call<T>(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<{ status: number; body: T }> {
  const { cookie, ...rest } = init;
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    ...rest,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
      ...rest.headers,
    },
  });
  return { status: response.status, body: (await response.json()) as T };
}

const post = <T>(path: string, body?: unknown, cookie = adminCookie) =>
  call<T>(path, {
    method: 'POST',
    cookie,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

function bytes(size: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(size)).fill(7);
}

/** Grant, `PUT`, finalise — the three-step upload, through the real API and the real store. */
async function uploadRecording(title: string): Promise<RecordingSummary> {
  const grant = await post<UploadGrantPayload>(RECORDING_UPLOADS_PATH, {
    filename: 'sunday-teaching.mp3',
    contentType: ACCEPTED_AUDIO_FORMATS.mp3,
    size: 256,
  });
  expect(grant.status).toBe(200);

  const put = await fetch(grant.body.url, {
    method: 'PUT',
    headers: { 'content-type': grant.body.contentType },
    body: bytes(256),
  });
  expect(put.status).toBe(200);

  const created = await post<RecordingSummary>(RECORDINGS_PATH, {
    key: grant.body.key,
    title,
    recordedAt: '2026-08-16',
  });
  expect(created.status).toBe(201);
  return created.body;
}

/**
 * Run the real worker loop until `settled`, then stop it.
 *
 * Driven for a bounded time rather than started as a process, so the suite has nothing to kill.
 */
async function runWorkerUntil(settled: () => Promise<boolean>): Promise<void> {
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
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await settled()) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('the worker never reached the state this test is waiting for');
  } finally {
    loop.stop();
    await loop.done;
  }
}

/** Whether every step of this recording's pipeline has succeeded. */
async function pipelineFinished(recordingId: string): Promise<boolean> {
  const rows = await sql<{ status: string }[]>`
    select distinct on (step) status::text as status from job
    where recording_id = ${recordingId} order by step, attempt desc
  `;
  return rows.length === PIPELINE_STEPS.length && rows.every((row) => row.status === 'succeeded');
}

/** This recording's open drafts, as the queue answers them. */
async function queueFor(recordingId: string): Promise<ReviewItemView[]> {
  const listed = await call<ReviewListPayload>(REVIEWS_PATH, { cookie: adminCookie });
  expect(listed.status).toBe(200);
  return listed.body.reviews.filter((one) => one.recordingId === recordingId);
}

/** This recording, as a member is answered. `undefined` when they are not answered it at all. */
async function asMember(recordingId: string): Promise<RecordingView | undefined> {
  const listed = await call<RecordingListPayload>(RECORDINGS_PATH, { cookie: memberCookie });
  expect(listed.status).toBe(200);
  return listed.body.recordings.find((one) => one.id === recordingId);
}

beforeAll(async () => {
  // The worker runs **in this process**, and the media store reads its five values from the
  // environment with no defaults — and the suite's bucket is not the one `.env` names. So the
  // worker is given the same configuration the servers got, exactly as the pipeline suite does.
  Object.assign(process.env, mediaSettings);

  handle = createDatabase({ url: databaseUrl, max: 6 });
  sql = postgres(databaseUrl, { max: 4, onnotice: () => {} });

  const signedInAdmin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'flow-admin');
  admin = signedInAdmin.account;
  adminCookie = signedInAdmin.cookie;

  const signedInMember = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'flow-member');
  member = signedInMember.account;
  memberCookie = signedInMember.cookie;
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await sql?.end({ timeout: 5 });
  await closeTestDatabase();
});

// =================================================================================================

describe('upload, transcribe, draft, review, publish', () => {
  it('leaves a recording a member reads with its summary and its description', async () => {
    const created = await uploadRecording(`End to end ${Date.now().toString(36)}`);

    // Nothing told the worker about this upload; the ledger did.
    await runWorkerUntil(() => pipelineFinished(created.id));

    // Two drafts waiting, and **nothing member-visible yet** — which is the whole point of the gate.
    const waiting = await queueFor(created.id);
    expect(waiting.map((one) => one.kind).sort()).toEqual([...REVIEW_KINDS].sort());
    expect(await asMember(created.id)).toBeUndefined();

    for (const item of waiting) {
      expect((await post(reviewPath(item.id), { action: 'approve' })).status).toBe(200);
    }

    // Approved, and *still* invisible: approving a summary publishes the summary, and the teaching
    // going live is a separate press.
    expect(await asMember(created.id)).toBeUndefined();

    expect((await post(recordingPublishPath(created.id))).status).toBe(200);

    const visible = await asMember(created.id);
    expect(visible).toBeDefined();
    expect(visible?.summary).toBe(DRAFT.summary);
    expect(visible?.description).toBe(DRAFT.description);
    expect(visible?.publishedAt).not.toBeNull();
    // And a member never receives what only an operator has business with.
    expect(visible).not.toHaveProperty('originalMediaKey');

    // Unpublishing removes it from that answer, and deletes nothing.
    expect((await post(recordingUnpublishPath(created.id))).status).toBe(200);
    expect(await asMember(created.id)).toBeUndefined();
  }, 240_000);

  it('publishes the second draft’s text when the first one was steered away', async () => {
    const created = await uploadRecording(`Regenerated ${Date.now().toString(36)}`);
    await runWorkerUntil(() => pipelineFinished(created.id));

    const summaryDraft = (await queueFor(created.id)).find((one) => one.kind === 'summary');
    expect(summaryDraft?.fields['summary']).toBe(DRAFT.summary);

    const steer = 'Say more about the second half.';
    const again = await post<RegenerateReviewPayload>(reviewRegeneratePath(summaryDraft?.id ?? ''), {
      prompt: steer,
    });
    expect(again.status).toBe(200);

    // The same handler the chain runs, told which kind and what to change.
    await runWorkerUntil(async () => (await queueFor(created.id)).some((one) => one.kind === 'summary'));

    const second = (await queueFor(created.id)).find((one) => one.kind === 'summary');
    expect(second?.id).not.toBe(summaryDraft?.id);
    // The fake echoes the steer into the text, which is how this test can tell a second draft from
    // the first one read back.
    expect(second?.fields['summary']).toContain(steer);
    expect(second?.provenance.steeringPrompt).toBe(steer);

    for (const item of await queueFor(created.id)) {
      expect((await post(reviewPath(item.id), { action: 'approve' })).status).toBe(200);
    }
    expect((await post(recordingPublishPath(created.id))).status).toBe(200);

    // What went live is the second draft, not the one that was steered away.
    expect((await asMember(created.id))?.summary).toContain(steer);
  }, 240_000);

  it('never lets the member read reach the queue or the console’s fields', async () => {
    // The other half of "refused by the API, not merely by the interface": a member holding a real
    // session still cannot see what is waiting on an admin.
    const refused = await call(REVIEWS_PATH, { cookie: memberCookie });
    expect(refused.status).toBe(403);
    expect(member.email).not.toBe(admin.email);
  });
});
