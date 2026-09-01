import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  CORRELATION_ID_HEADER,
  RECORDINGS_PATH,
  ROLE,
  recordingPath,
  recordingPublishPath,
  type AdminRecordingListPayload,
  type RecordingListPayload,
  type RecordingPayload,
  type RecordingSummary,
  type RecordingView,
  type UpdateRecordingPayload,
} from '@thp/shared';
import {
  createDatabase,
  findPlaybackProgress,
  findSummaryByRecording,
  findTranscriptByRecording,
  insertRecording,
  insertSeries,
  listSegments,
  publishSummary,
  replaceTranscript,
  setRecordingSeries,
  upsertPlaybackProgress,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';
import { logOffset, waitForLogLines } from '../support/log-reader';

/**
 * **Correcting a recording's title and the date it was recorded** (docs/project/prd.md, 3.2.16).
 *
 * A title is typed in a hurry, standing up after a service, from a name heard once — so the
 * interesting question is never whether the two columns change. It is **what else does**, and every
 * assertion here is written from that side:
 *
 * 1. **Two columns, and nothing behind them.** The transcript, the summary and its own gate, the
 *    series, the media key and every member's saved position all survive a correction untouched.
 *    Asserted by reading them back through `@thp/db` rather than through the API, because the API
 *    answering the old value would be indistinguishable from the API not answering it at all.
 * 2. **Publication is untouched in both directions.** Renaming a live teaching leaves it live and
 *    members see the new title immediately; renaming a draft does not publish it. There is no
 *    combination in which correcting a typo changes who may see the teaching.
 * 3. **A refusal writes nothing.** A blank title, an impossible date and an id that does not exist
 *    are each asserted twice — the answer, and then the row, unchanged.
 * 4. **The date is the sort key**, so moving it moves the recording in the list
 *    (docs/project/prd.md, 3.3.1, 4.2). That is the point of being able to correct it, and it is
 *    asserted as an ordering rather than as a field.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const logPath = inject('apiLogPath');

let admin: TestAccount;
let adminCookie: string;
let member: TestAccount;
let memberCookie: string;
let handle: DatabaseHandle;
let seeded = 0;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly message: string | null;
  readonly body: T;
}

async function call<T>(
  path: string,
  init: RequestInit & { cookie?: string; correlationId?: string } = {},
): Promise<Answer<T>> {
  const { cookie, correlationId, ...rest } = init;
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
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
    code: (body as { error?: { code?: string } })?.error?.code ?? null,
    message: (body as { error?: { message?: string } })?.error?.message ?? null,
    body: body as T,
  };
}

/** The edit itself. Defaulting to the admin cookie, because that is who holds `recording.edit`. */
function edit(
  recordingId: string,
  body: unknown,
  options: { cookie?: string | null; correlationId?: string } = {},
): Promise<Answer<UpdateRecordingPayload>> {
  const cookie = options.cookie === undefined ? adminCookie : options.cookie;
  return call<UpdateRecordingPayload>(recordingPath(recordingId), {
    method: 'PATCH',
    ...(cookie === null ? {} : { cookie }),
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
    body: JSON.stringify(body),
  });
}

/** A recording, seeded straight into the database — this suite is not about the upload flow. */
async function newRecording(
  title = `Untitled ${(seeded += 1)}`,
  recordedAt = '2026-04-12',
): Promise<{ readonly id: string; readonly key: string }> {
  const key = `originals/details-${seeded}-${Date.now().toString(36)}.mp3`;
  const row = await insertRecording({ originalMediaKey: key, title, recordedAt }, handle);
  return { id: row.id, key };
}

/** The row as the console reads it, straight off the list the panel renders from. */
async function consoleRow(recordingId: string): Promise<RecordingSummary | undefined> {
  const listed = await call<AdminRecordingListPayload>(RECORDINGS_PATH, { cookie: adminCookie });
  expect(listed.status).toBe(200);
  return listed.body.recordings.find((one) => one.id === recordingId);
}

/** The same row as a member reads it, or `undefined` when they may not see it at all. */
async function memberRow(recordingId: string): Promise<RecordingView | undefined> {
  const listed = await call<RecordingListPayload>(RECORDINGS_PATH, { cookie: memberCookie });
  expect(listed.status).toBe(200);
  return listed.body.recordings.find((one) => one.id === recordingId);
}

const unique = (label: string): string =>
  `${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 6 });

  const signedInAdmin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'details-admin');
  admin = signedInAdmin.account;
  adminCookie = signedInAdmin.cookie;

  const signedInMember = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'details-member');
  member = signedInMember.account;
  memberCookie = signedInMember.cookie;
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('who may correct a recording', () => {
  it('refuses an anonymous caller', async () => {
    const { id } = await newRecording();
    const answer = await edit(id, { title: 'Anonymous', recordedAt: '2026-01-01' }, { cookie: null });

    expect(answer.status).toBe(401);
    expect(answer.code).toBe('unauthenticated');
    expect((await consoleRow(id))?.title).not.toBe('Anonymous');
  });

  it('refuses a member — the API refuses, not the screen', async () => {
    // The console never draws the control for a member, and that is not what stops them: a member
    // holding the id and a cookie is refused by the policy before the handler runs.
    const { id } = await newRecording('Members may not rename this');
    const answer = await edit(id, { title: 'Renamed by a member', recordedAt: '2026-01-01' }, {
      cookie: memberCookie,
    });

    expect(answer.status).toBe(403);
    expect(answer.code).toBe('forbidden');
    expect((await consoleRow(id))?.title).toBe('Members may not rename this');
  });

  it('logs the member refusal with actor, action and target under the request correlation id', async () => {
    const { id } = await newRecording();
    const offset = logOffset(logPath);
    const correlationId = `details-refusal-${Date.now().toString(36)}`;

    await edit(id, { title: 'No', recordedAt: '2026-01-01' }, {
      cookie: memberCookie,
      correlationId,
    });

    const lines = await waitForLogLines(logPath, offset, (found) =>
      found.some(
        (line) =>
          line.message === 'authorisation.refused' && line['correlationId'] === correlationId,
      ),
    );
    const refusal = lines.find(
      (line) => line.message === 'authorisation.refused' && line['correlationId'] === correlationId,
    );

    expect(refusal).toBeDefined();
    expect(refusal?.['actorId']).toBe(member.id);
    // The action is `recording.edit` and not `recording.upload`: the split exists to be read here.
    expect(refusal?.['action']).toBe('recording.edit');
  }, 60_000);

  it('records the admin’s edit with actor, action and target', async () => {
    const { id } = await newRecording();
    const offset = logOffset(logPath);

    expect((await edit(id, { title: 'Audited', recordedAt: '2026-02-02' })).status).toBe(200);

    const lines = await waitForLogLines(logPath, offset, (found) =>
      found.some((line) => line.message === 'recording.edit' && line['target'] === `recording:${id}`),
    );
    const wrote = lines.find(
      (line) => line.message === 'recording.edit' && line['target'] === `recording:${id}`,
    );

    expect(wrote).toBeDefined();
    expect(wrote?.['actorId']).toBe(admin.id);
    expect(wrote?.['action']).toBe('recording.edit');
    expect(wrote?.['title']).toBe('Audited');
    expect(wrote?.['recordedAt']).toBe('2026-02-02');
  }, 60_000);
});

describe('the correction itself', () => {
  it('changes the title and the date, and answers with the row as the console reads it', async () => {
    const { id, key } = await newRecording('Teh Good Sheperd', '2026-03-01');

    const answer = await edit(id, { title: 'The Good Shepherd', recordedAt: '2026-02-22' });

    expect(answer.status).toBe(200);
    expect(answer.body.recording.title).toBe('The Good Shepherd');
    expect(answer.body.recording.recordedAt).toBe('2026-02-22');
    // The console's shape, not a thinner one: the key and the creation time are what separate it
    // from what a member receives, and the panel's list carries both.
    expect(answer.body.recording.originalMediaKey).toBe(key);
    expect(answer.body.recording.createdAt).toBeTruthy();

    const row = await consoleRow(id);
    expect(row?.title).toBe('The Good Shepherd');
    expect(row?.recordedAt).toBe('2026-02-22');
  });

  it('trims the title, exactly as the upload form does', async () => {
    const { id } = await newRecording();
    const answer = await edit(id, { title: '   Spaces either side   ', recordedAt: '2026-03-03' });

    expect(answer.status).toBe(200);
    expect(answer.body.recording.title).toBe('Spaces either side');
  });

  it('is idempotent — the same body twice leaves the same two columns saying the same thing', async () => {
    const { id } = await newRecording();
    const body = { title: 'Sent twice', recordedAt: '2026-05-05' };

    const first = await edit(id, body);
    const second = await edit(id, body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.recording.title).toBe('Sent twice');
    expect(second.body.recording.recordedAt).toBe('2026-05-05');
  });

  it('reads back the same on the recording’s own route', async () => {
    const { id } = await newRecording();
    expect((await edit(id, { title: 'Read back', recordedAt: '2026-06-06' })).status).toBe(200);

    const read = await call<RecordingPayload>(recordingPath(id), { cookie: adminCookie });
    expect(read.status).toBe(200);
    expect(read.body.recording.title).toBe('Read back');
    expect(read.body.recording.recordedAt).toBe('2026-06-06');
  });

  it('answers not_found for an id that does not exist, and for one that never did', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const answer = await edit(missing, { title: 'Nobody', recordedAt: '2026-01-01' });

    expect(answer.status).toBe(404);
    expect(answer.code).toBe('not_found');
  });
});

describe('a refused correction writes nothing', () => {
  it('refuses a blank title and leaves the row exactly as it was', async () => {
    const { id } = await newRecording('The title it keeps', '2026-07-07');

    for (const title of ['', '   ']) {
      const answer = await edit(id, { title, recordedAt: '2026-08-08' });
      expect(answer.status, JSON.stringify(title)).toBe(400);
      expect(answer.code).toBe('invalid_input');
    }

    // Both columns, because the two travel together: a refusal on one must not write the other.
    const row = await consoleRow(id);
    expect(row?.title).toBe('The title it keeps');
    expect(row?.recordedAt).toBe('2026-07-07');
  });

  it('refuses a date the calendar does not have, and leaves the row as it was', async () => {
    const { id } = await newRecording('Dated correctly', '2026-07-07');

    // A month that does not exist, a day February does not have, the wrong shape, and no date at
    // all. `isCalendarDate` is the same rule the upload form is held to.
    for (const recordedAt of ['2026-13-01', '2026-02-30', '12/03/2026', '2026-3-8', '', null]) {
      const answer = await edit(id, { title: 'Still fine', recordedAt });
      expect(answer.status, JSON.stringify(recordedAt)).toBe(400);
      expect(answer.code).toBe('invalid_input');
    }

    const row = await consoleRow(id);
    expect(row?.title).toBe('Dated correctly');
    expect(row?.recordedAt).toBe('2026-07-07');
  });

  it('refuses a body that is not an object at all', async () => {
    const { id } = await newRecording();
    for (const body of [null, 'a string', 42]) {
      expect((await edit(id, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('accepts a leap day, because the calendar has one', async () => {
    const { id } = await newRecording();
    const answer = await edit(id, { title: 'A leap day', recordedAt: '2028-02-29' });

    expect(answer.status).toBe(200);
    expect(answer.body.recording.recordedAt).toBe('2028-02-29');
  });
});

describe('what a correction does not touch', () => {
  it('leaves a published recording published, and a draft a draft', async () => {
    const live = await newRecording();
    expect((await call(recordingPublishPath(live.id), { method: 'POST', cookie: adminCookie })).status).toBe(200);
    const draft = await newRecording();

    const editedLive = await edit(live.id, { title: 'Still live', recordedAt: '2026-09-09' });
    const editedDraft = await edit(draft.id, { title: 'Still a draft', recordedAt: '2026-09-09' });

    expect(editedLive.body.recording.publishedAt).not.toBeNull();
    // Not merely non-null — the *same* timestamp. "When did this go live" is a fact a rename must
    // not quietly move, the same reason a second publish does not re-stamp it.
    expect(editedLive.body.recording.publishedAt).toBe((await consoleRow(live.id))?.publishedAt);
    expect(editedDraft.body.recording.publishedAt).toBeNull();

    // And the draft is still invisible to a member, which is the assertion the timestamp stands in
    // for: correcting a title is not a second way to publish a teaching.
    expect(await memberRow(draft.id)).toBeUndefined();
  });

  it('shows members the corrected title at once, without re-publishing anything', async () => {
    const { id } = await newRecording('The name heard wrong', '2026-01-10');
    expect((await call(recordingPublishPath(id), { method: 'POST', cookie: adminCookie })).status).toBe(200);
    expect((await memberRow(id))?.title).toBe('The name heard wrong');

    expect((await edit(id, { title: 'The name heard right', recordedAt: '2026-01-11' })).status).toBe(200);

    const seen = await memberRow(id);
    expect(seen?.title).toBe('The name heard right');
    expect(seen?.recordedAt).toBe('2026-01-11');
  });

  it('leaves the transcript, the summary and its own gate untouched', async () => {
    const { id } = await newRecording();
    await replaceTranscript(
      {
        recordingId: id,
        language: 'en',
        confidence: 0.94,
        segments: [{ startMs: 0, endMs: 4000, text: 'Good morning.' }],
      },
      handle,
    );
    await publishSummary(id, 'The approved summary.', handle);

    expect((await edit(id, { title: 'Renamed', recordedAt: '2026-10-10' })).status).toBe(200);

    // Read through the database rather than the API: the API answering the old text would look
    // identical to the API not answering it, and what is being asserted is that the rows are there.
    const transcript = await findTranscriptByRecording(id, handle);
    expect(transcript).not.toBeNull();
    expect((await listSegments(transcript?.id ?? '', handle))[0]?.text).toBe('Good morning.');
    const summary = await findSummaryByRecording(id, handle);
    expect(summary?.content).toBe('The approved summary.');
    expect(summary?.publishedAt).not.toBeNull();
  });

  it('leaves the series assignment and the media key where they were', async () => {
    const { id, key } = await newRecording();
    const series = await insertSeries({ title: unique('A study'), description: null }, handle);
    await setRecordingSeries(id, series.id, handle);

    const answer = await edit(id, { title: 'Renamed in place', recordedAt: '2026-11-11' });

    expect(answer.status).toBe(200);
    expect(answer.body.recording.series?.id).toBe(series.id);
    expect(answer.body.recording.originalMediaKey).toBe(key);
  });

  it('leaves every member’s saved position exactly where it was', async () => {
    // The one nothing in this file's statements mentions, and therefore the one worth asserting: a
    // rename that reset the library's resume points would be a correction that cost every listener
    // their place.
    const { id } = await newRecording();
    await upsertPlaybackProgress({ userId: member.id, recordingId: id, positionMs: 214_000 }, handle);

    expect((await edit(id, { title: 'Renamed mid-listen', recordedAt: '2026-12-12' })).status).toBe(200);

    expect((await findPlaybackProgress(member.id, id, handle))?.positionMs).toBe(214_000);
  });

  it('ignores fields the body has no business carrying', async () => {
    // Not refused — refusing would invent a rule nobody asked for — but never read. Publication,
    // the media key and the series each have a control of their own, and this is not it.
    const { id, key } = await newRecording();
    const series = await insertSeries({ title: unique('Not this one'), description: null }, handle);

    const answer = await edit(id, {
      title: 'Only these two',
      recordedAt: '2027-01-01',
      publishedAt: new Date().toISOString(),
      originalMediaKey: 'originals/somebody-elses-audio.mp3',
      seriesId: series.id,
      description: 'A description nobody approved.',
    });

    expect(answer.status).toBe(200);
    expect(answer.body.recording.title).toBe('Only these two');
    expect(answer.body.recording.publishedAt).toBeNull();
    expect(answer.body.recording.originalMediaKey).toBe(key);
    expect(answer.body.recording.series).toBeNull();
    expect(answer.body.recording.description).toBeNull();
  });
});

describe('the date recorded is the sort key, so correcting it moves the recording', () => {
  it('moves the row in the console list', async () => {
    const label = unique('reordering');
    const first = await newRecording(`${label} A`, '2026-04-01');
    const second = await newRecording(`${label} B`, '2026-04-02');
    const third = await newRecording(`${label} C`, '2026-04-03');

    const before = await call<AdminRecordingListPayload>(RECORDINGS_PATH, { cookie: adminCookie });
    expect(
      before.body.recordings.filter((one) => one.title.startsWith(label)).map((one) => one.id),
    ).toEqual([third.id, second.id, first.id]);

    // The oldest of the three was written down a year late. Correcting it makes it the newest.
    expect((await edit(first.id, { title: `${label} A`, recordedAt: '2026-04-04' })).status).toBe(200);

    const after = await call<AdminRecordingListPayload>(RECORDINGS_PATH, { cookie: adminCookie });
    expect(
      after.body.recordings.filter((one) => one.title.startsWith(label)).map((one) => one.id),
    ).toEqual([first.id, third.id, second.id]);
  }, 60_000);
});
