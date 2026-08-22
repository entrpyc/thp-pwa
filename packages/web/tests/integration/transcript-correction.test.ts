import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  API_PREFIX,
  REVIEWS_PATH,
  ROLE,
  isApiErrorBody,
  memberRecordingPath,
  recordingProgressPath,
  recordingSummaryRegeneratePath,
  recordingTranscriptPath,
  reviewPath,
  transcriptSegmentPath,
  type CorrectSegmentPayload,
  type RecordingPayload,
  type RegenerateSummaryPayload,
  type ReviewItemView,
  type ReviewListPayload,
  type TranscriptPayload,
  type TranscriptSegmentView,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  publishSummary,
  replaceTranscript,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { startWorkerLoop } from '../../../worker/src/loop';
import { createHandlers } from '../../../worker/src/handlers';
import { fakeTranscriber } from '../../../worker/src/asr';
import { fakeGenerator } from '../../../worker/src/generate';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';
import { logOffset, waitForLogLines } from '../support/log-reader';

/**
 * **Correction, and the regeneration offer** (Story 5 Ticket 02) —
 * [3.5.5](docs/project/prd.md)–[3.5.6](docs/project/prd.md).
 *
 * The three claims this suite exists for, none of which a unit test could make:
 *
 * 1. **A refused correction leaves the transcript exactly as it was.** Every refusal is followed by
 *    a re-read of the segment, because "the API answered 400" and "nothing was written" are two
 *    different facts and only the second one matters to a member reading along.
 * 2. **The published summary never goes dark.** Read as a member after accepting the offer and
 *    again after the draft lands, and it is the old summary both times — the new one is a draft in
 *    the Pending Reviews queue, and approving it is what replaces the live text.
 * 3. **Nothing here touches progress or publication.** Asserted rather than read off the code,
 *    which is what turns it from a claim about two routes into a property.
 *
 * The worker is the real loop against the real ledger; only the two providers are faked, the way a
 * deployment selects one.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const mediaSettings = inject('mediaSettings');
const logPath = inject('apiLogPath');

/** Four lines with a deliberate silence between the third and the fourth. */
const SEGMENTS = [
  { startMs: 0, endMs: 4000, text: 'Good morning, and welcome.', speaker: 0 },
  { startMs: 4000, endMs: 9000, text: 'We are reading from Paul today.', speaker: 0 },
  { startMs: 9000, endMs: 15_000, text: 'A word about Epafras before we begin.', speaker: 1 },
  // the gap: 15_000 → 18_000
  { startMs: 18_000, endMs: 24_000, text: 'Turn with me to the second chapter.', speaker: 0 },
] as const;

const LIVE_SUMMARY = 'The teaching stays with the second chapter throughout.';
const REGENERATED = { summary: 'A summary written from the corrected words.', description: 'Desc.' };

let handle: DatabaseHandle;
let sql: postgres.Sql;
let admin: TestAccount;
let adminCookie: string;
let member: TestAccount;
let memberCookie: string;

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

/** A published teaching with a transcript, a live summary, and its own key. */
async function publishedTeaching(label: string): Promise<string> {
  const row = await insertRecording(
    {
      originalMediaKey: `originals/${label}-${Math.random().toString(36).slice(2)}.mp3`,
      title: `Correction ${label}`,
      recordedAt: '2026-08-16',
    },
    handle,
  );
  await replaceTranscript(
    { recordingId: row.id, language: 'en', confidence: 0.94, segments: SEGMENTS },
    handle,
  );
  await publishSummary(row.id, LIVE_SUMMARY, handle);
  await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

async function readSegments(recordingId: string, cookie = adminCookie): Promise<TranscriptSegmentView[]> {
  const read = await call<TranscriptPayload>(recordingTranscriptPath(recordingId), { cookie });
  expect(read.status).toBe(200);
  return [...(read.body.transcript?.segments ?? [])];
}

function correct(
  recordingId: string,
  segmentId: string,
  body: unknown,
  cookie = adminCookie,
): Promise<{ status: number; body: unknown }> {
  return call(transcriptSegmentPath(recordingId, segmentId), {
    method: 'PATCH',
    cookie,
    body: JSON.stringify(body),
  });
}

/** This recording's open drafts, as the queue answers them. */
async function queueFor(recordingId: string): Promise<ReviewItemView[]> {
  const listed = await call<ReviewListPayload>(REVIEWS_PATH, { cookie: adminCookie });
  expect(listed.status).toBe(200);
  return listed.body.reviews.filter((one) => one.recordingId === recordingId);
}

/** The summary a member is answered — the only reading that proves anything about the gate. */
async function summaryAsMember(recordingId: string): Promise<string | null> {
  const read = await call<RecordingPayload>(memberRecordingPath(recordingId), {
    cookie: memberCookie,
  });
  expect(read.status).toBe(200);
  return read.body.recording.summary;
}

/** Run the real worker loop until `settled`, then stop it. */
async function runWorkerUntil(settled: () => Promise<boolean>): Promise<void> {
  const loop = startWorkerLoop({
    executor: handle,
    pollIntervalMs: 20,
    handlers: createHandlers({
      transcriber: fakeTranscriber({
        language: 'en',
        confidence: 0.9,
        durationSeconds: 24,
        segments: SEGMENTS.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
      }),
      generator: fakeGenerator(REGENERATED),
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

beforeAll(async () => {
  Object.assign(process.env, mediaSettings);
  handle = createDatabase({ url: databaseUrl, max: 6 });
  sql = postgres(databaseUrl, { max: 4, onnotice: () => {} });

  const signedInAdmin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'correct-admin');
  admin = signedInAdmin.account;
  adminCookie = signedInAdmin.cookie;

  const signedInMember = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'correct-member');
  member = signedInMember.account;
  memberCookie = signedInMember.cookie;
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await sql?.end({ timeout: 5 });
  await closeTestDatabase();
});

// =================================================================================================

describe('an admin corrects what the machine misheard', () => {
  it('changes the words and the timings, and a member reads the correction', async () => {
    const recordingId = await publishedTeaching('words');
    const before = await readSegments(recordingId);
    const third = before[2];
    if (third === undefined) throw new Error('expected four segments');

    const corrected = await correct(recordingId, third.id, {
      text: 'A word about Epaphras before we begin.',
      startMs: 9000,
      endMs: 16_000,
    });
    expect(corrected.status).toBe(200);
    expect((corrected.body as CorrectSegmentPayload).segment.text).toBe(
      'A word about Epaphras before we begin.',
    );

    // The reading that matters: a member, through the member route, after the fact.
    const asMember = await readSegments(recordingId, memberCookie);
    expect(asMember[2]?.text).toBe('A word about Epaphras before we begin.');
    expect(asMember[2]?.endMs).toBe(16_000);
    // And nothing else moved.
    expect(asMember.map((one) => one.id)).toEqual(before.map((one) => one.id));
    expect(asMember[1]?.text).toBe(before[1]?.text);
  });

  it('writes corrected_at and corrected_by_user_id on every accepted correction', async () => {
    const recordingId = await publishedTeaching('stamp');
    const [first] = await readSegments(recordingId);
    if (first === undefined) throw new Error('expected a segment');

    // The two columns Story 2 shipped unwritten, read straight off the row — they deliberately do
    // not cross the wire, so the database is the only place this is checkable.
    const untouched = await sql<{ corrected_at: Date | null; corrected_by_user_id: string | null }[]>`
      select corrected_at, corrected_by_user_id from segment where id = ${first.id}
    `;
    expect(untouched[0]?.corrected_at).toBeNull();
    expect(untouched[0]?.corrected_by_user_id).toBeNull();

    expect(
      (await correct(recordingId, first.id, { text: 'Good morning.', startMs: 0, endMs: 4000 }))
        .status,
    ).toBe(200);

    const stamped = await sql<{ corrected_at: Date | null; corrected_by_user_id: string | null }[]>`
      select corrected_at, corrected_by_user_id from segment where id = ${first.id}
    `;
    expect(stamped[0]?.corrected_at).not.toBeNull();
    expect(stamped[0]?.corrected_by_user_id).toBe(admin.id);
  });

  it('refuses a request carrying a speaker rather than silently ignoring it', async () => {
    const recordingId = await publishedTeaching('speaker');
    const [first] = await readSegments(recordingId);
    if (first === undefined) throw new Error('expected a segment');

    const refused = await correct(recordingId, first.id, {
      text: 'Good morning.',
      startMs: 0,
      endMs: 4000,
      speaker: 3,
    });
    expect(refused.status).toBe(400);
    if (!isApiErrorBody(refused.body)) throw new Error('expected an error envelope');
    expect(refused.body.error.code).toBe('invalid_input');

    // Nothing was written — not the speaker, and not the text that came with it.
    const after = await readSegments(recordingId);
    expect(after[0]?.text).toBe(SEGMENTS[0].text);
    expect(after[0]?.speaker).toBe(0);
  });
});

describe('a correction that would break the transcript’s order is refused', () => {
  it('drives the five refusals and leaves the segment exactly as it was after each', async () => {
    const recordingId = await publishedTeaching('bounds');
    const segments = await readSegments(recordingId);
    const second = segments[1];
    if (second === undefined) throw new Error('expected four segments');

    const refusals: { why: string; body: unknown }[] = [
      // Crosses the line before it: the first ends at 4000.
      { why: 'crosses the previous neighbour', body: { text: 'x', startMs: 3500, endMs: 9000 } },
      // Crosses the line after it: the third starts at 9000.
      { why: 'crosses the next neighbour', body: { text: 'x', startMs: 4000, endMs: 9500 } },
      { why: 'inverts its own bounds', body: { text: 'x', startMs: 9000, endMs: 4000 } },
      { why: 'goes negative', body: { text: 'x', startMs: -1, endMs: 9000 } },
      { why: 'empties the line', body: { text: '   ', startMs: 4000, endMs: 9000 } },
    ];

    for (const { why, body } of refusals) {
      const refused = await correct(recordingId, second.id, body);
      expect(refused.status, why).toBe(400);
      if (!isApiErrorBody(refused.body)) throw new Error(`expected an error envelope for ${why}`);
      expect(refused.body.error.code, why).toBe('invalid_input');

      // The half that matters: re-read after every one, because a refusal that still wrote would
      // pass an assertion about the status alone.
      const after = await readSegments(recordingId);
      expect(after[1], why).toEqual(second);
    }
  });

  it('allows a widened gap, which is a legitimate correction', async () => {
    const recordingId = await publishedTeaching('gap');
    const segments = await readSegments(recordingId);
    const third = segments[2];
    if (third === undefined) throw new Error('expected four segments');

    // 9000–15_000 becomes 9500–12_000: gaps on both sides, and no overlap anywhere.
    const widened = await correct(recordingId, third.id, {
      text: 'A word before we begin.',
      startMs: 9500,
      endMs: 12_000,
    });
    expect(widened.status).toBe(200);

    const after = await readSegments(recordingId);
    expect(after[2]?.startMs).toBe(9500);
    expect(after[2]?.endMs).toBe(12_000);
  });

  it('lets the first line reach 0 and the last one run past where the others end', async () => {
    const recordingId = await publishedTeaching('edges');
    const segments = await readSegments(recordingId);
    const [first] = segments;
    const last = segments[segments.length - 1];
    if (first === undefined || last === undefined) throw new Error('expected four segments');

    expect((await correct(recordingId, first.id, { text: 'Morning.', startMs: 0, endMs: 3000 })).status).toBe(200);
    // No ceiling on the last one: nothing in this epic stores a duration to compare against.
    expect(
      (await correct(recordingId, last.id, { text: 'Chapter two.', startMs: 18_000, endMs: 900_000 }))
        .status,
    ).toBe(200);
  });
});

describe('a member is refused by the API', () => {
  it('answers forbidden to a member holding a real session', async () => {
    const recordingId = await publishedTeaching('member');
    const [first] = await readSegments(recordingId);
    if (first === undefined) throw new Error('expected a segment');

    const refused = await correct(
      recordingId,
      first.id,
      { text: 'Not mine to change.', startMs: 0, endMs: 4000 },
      memberCookie,
    );
    expect(refused.status).toBe(403);
    if (!isApiErrorBody(refused.body)) throw new Error('expected an error envelope');
    expect(refused.body.error.code).toBe('forbidden');
    expect((await readSegments(recordingId))[0]?.text).toBe(SEGMENTS[0].text);

    // The same member reads the transcript perfectly well — this is the write that is refused.
    expect(member.email).not.toBe(admin.email);
    expect((await readSegments(recordingId, memberCookie)).length).toBe(SEGMENTS.length);
  });

  it('refuses a member the regeneration route too', async () => {
    const recordingId = await publishedTeaching('member-regen');
    const refused = await call(recordingSummaryRegeneratePath(recordingId), {
      method: 'POST',
      cookie: memberCookie,
    });
    expect(refused.status).toBe(403);
  });
});

describe('accepting the offer produces a draft the approve press publishes', () => {
  it('enqueues one generate_draft, lands one open summary review, and approving replaces the summary', async () => {
    const recordingId = await publishedTeaching('regen');
    expect(await summaryAsMember(recordingId)).toBe(LIVE_SUMMARY);

    const asked = await call<RegenerateSummaryPayload>(
      recordingSummaryRegeneratePath(recordingId),
      { method: 'POST', cookie: adminCookie },
    );
    expect(asked.status).toBe(200);
    expect(asked.body.recordingId).toBe(recordingId);
    expect(asked.body.jobId).toBeTruthy();

    // The published summary is still what a member reads, before the worker has done anything.
    expect(await summaryAsMember(recordingId)).toBe(LIVE_SUMMARY);

    await runWorkerUntil(async () => (await queueFor(recordingId)).length > 0);

    const waiting = await queueFor(recordingId);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.kind).toBe('summary');
    expect(waiting[0]?.status).toBe('draft');
    expect(waiting[0]?.fields['summary']).toBe(REGENERATED.summary);
    // The AI-suggested provenance every draft carries (docs/project/prd.md 4.17.5).
    expect(waiting[0]?.provenance.fields?.['summary']?.aiSuggested).toBe(true);

    // Still the old summary, with the new one sitting in the queue — the whole point of the path.
    expect(await summaryAsMember(recordingId)).toBe(LIVE_SUMMARY);

    const approved = await call(reviewPath(waiting[0]?.id ?? ''), {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(approved.status).toBe(200);
    expect(await summaryAsMember(recordingId)).toBe(REGENERATED.summary);
  }, 180_000);

  it('refuses a second regeneration while one is in flight', async () => {
    const recordingId = await publishedTeaching('inflight');

    const first = await call(recordingSummaryRegeneratePath(recordingId), {
      method: 'POST',
      cookie: adminCookie,
    });
    expect(first.status).toBe(200);

    const second = await call(recordingSummaryRegeneratePath(recordingId), {
      method: 'POST',
      cookie: adminCookie,
    });
    expect(second.status).toBe(409);
    if (!isApiErrorBody(second.body)) throw new Error('expected an error envelope');
    // Refused rather than answered with the first request's job, which would be a wrong answer
    // wearing a success.
    expect(second.body.error.code).toBe('generation_in_flight');
  });

  it('leaves nothing behind when the offer is never accepted', async () => {
    const recordingId = await publishedTeaching('declined');
    const [first] = await readSegments(recordingId);
    if (first === undefined) throw new Error('expected a segment');

    expect(
      (await correct(recordingId, first.id, { text: 'Good morning all.', startMs: 0, endMs: 4000 }))
        .status,
    ).toBe(200);

    // Correcting alone enqueues nothing and creates nothing: the offer is an offer.
    const jobs = await sql<{ count: string }[]>`
      select count(*)::text as count from job where recording_id = ${recordingId}
    `;
    expect(jobs[0]?.count).toBe('0');
    expect(await queueFor(recordingId)).toHaveLength(0);
  });
});

describe('correcting and regenerating leave progress and publication alone', () => {
  it('does not move a stored position or the recording’s published_at', async () => {
    const recordingId = await publishedTeaching('untouched');
    const [first] = await readSegments(recordingId);
    if (first === undefined) throw new Error('expected a segment');

    const wrote = await call(recordingProgressPath(recordingId), {
      method: 'PUT',
      cookie: memberCookie,
      body: JSON.stringify({ positionMs: 12_345 }),
    });
    expect(wrote.status).toBe(200);

    const before = await sql<{ published_at: Date | null }[]>`
      select published_at from recording where id = ${recordingId}
    `;

    expect(
      (await correct(recordingId, first.id, { text: 'Morning, everyone.', startMs: 0, endMs: 4000 }))
        .status,
    ).toBe(200);
    expect(
      (await call(recordingSummaryRegeneratePath(recordingId), { method: 'POST', cookie: adminCookie }))
        .status,
    ).toBe(200);

    const after = await sql<{ published_at: Date | null }[]>`
      select published_at from recording where id = ${recordingId}
    `;
    expect(after[0]?.published_at?.toISOString()).toBe(before[0]?.published_at?.toISOString());

    const progress = await sql<{ position_ms: number }[]>`
      select position_ms from playback_progress
      where recording_id = ${recordingId} and user_id = ${member.id}
    `;
    expect(progress[0]?.position_ms).toBe(12_345);
  });
});

describe('every correction and every regeneration is logged', () => {
  it('records actor, action, target and timestamp for both', async () => {
    const recordingId = await publishedTeaching('logged');
    const [first] = await readSegments(recordingId);
    if (first === undefined) throw new Error('expected a segment');
    const offset = logOffset(logPath);

    expect(
      (await correct(recordingId, first.id, { text: 'Welcome, all.', startMs: 0, endMs: 4000 }))
        .status,
    ).toBe(200);
    expect(
      (await call(recordingSummaryRegeneratePath(recordingId), { method: 'POST', cookie: adminCookie }))
        .status,
    ).toBe(200);

    const lines = await waitForLogLines(
      logPath,
      offset,
      (candidates) =>
        candidates.some((line) => line.message === 'transcript.correct') &&
        candidates.some((line) => line.message === 'summary.regenerate'),
    );

    const correction = lines.find((line) => line.message === 'transcript.correct');
    expect(correction?.['actorId']).toBe(admin.id);
    expect(correction?.['action']).toBe('transcript.correct');
    expect(correction?.['target']).toBe(`segment:${first.id}`);
    expect(correction?.['recordingId']).toBe(recordingId);
    expect(typeof correction?.time).toBe('string');

    const regeneration = lines.find((line) => line.message === 'summary.regenerate');
    expect(regeneration?.['actorId']).toBe(admin.id);
    expect(regeneration?.['action']).toBe('summary.regenerate');
    expect(regeneration?.['target']).toBe(`recording:${recordingId}`);
    expect(typeof regeneration?.time).toBe('string');
  });
});
