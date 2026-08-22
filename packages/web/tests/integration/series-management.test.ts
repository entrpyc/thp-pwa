import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  API_PREFIX,
  FIRST_PIPELINE_STEP,
  ROLE,
  SERIES_PATH,
  recordingSeriesPath,
  seriesPath,
  type SeriesListPayload,
  type SeriesView,
} from '@thp/shared';
import {
  createDatabase,
  enqueueJob,
  insertRecording,
  publishSummary,
  replaceTranscript,
  setRecordingDescription,
  setRecordingPublication,
  setSummaryPublication,
  upsertPlaybackProgress,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';
import { logOffset, waitForLogLines } from '../support/log-reader';

/**
 * **Series management** (Story 6 Ticket 01) — the admin write surface, driven over HTTP against the
 * running server.
 *
 * The claim with teeth is the third block: **moving a recording between series loses nothing.**
 * Everything about the recording is snapshotted straight out of the database before an
 * assign-move-clear sequence and compared afterwards — the row, its transcript, its summary, its
 * jobs, and every member's stored position with its `updated_at`. Asserted rather than inferred
 * from the schema, because the assertion is what will still be true after somebody later adds a
 * cascade nobody thought about.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const logPath = inject('apiLogPath');


const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let handle: DatabaseHandle;
let sql: postgres.Sql;
let admin: TestAccount;
let adminCookie: string;
let member: TestAccount;
let memberCookie: string;
let secondMember: TestAccount;
let seeded = 0;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly body: T;
}

async function call<T>(
  path: string,
  init: { method?: string; cookie?: string; body?: string } = {},
): Promise<Answer<T>> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
    },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const body = (await response.json().catch(() => undefined)) as T & {
    error?: { code: string };
  };
  return { status: response.status, code: body?.error?.code ?? null, body };
}

async function newRecording(title: string, recordedAt = '2026-05-01'): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    { originalMediaKey: `originals/series-mgmt-${RUN}-${seeded}.mp3`, title, recordedAt },
    handle,
  );
  return row.id;
}

async function createSeries(title: string, description: string | null = null): Promise<SeriesView> {
  const created = await call<{ series: SeriesView }>(SERIES_PATH, {
    method: 'POST',
    cookie: adminCookie,
    body: JSON.stringify({ title, description }),
  });
  if (created.status !== 201) throw new Error(`create refused: ${created.status}`);
  return created.body.series;
}

/** Every series this run wrote, as the console reads them. */
async function ours(cookie = adminCookie): Promise<SeriesView[]> {
  const list = await call<SeriesListPayload>(SERIES_PATH, { cookie });
  return list.body.series.filter((one) => one.title.endsWith(RUN));
}

/** Everything the database holds about a recording, so "unchanged" is comparable. */
async function snapshot(recordingId: string): Promise<Record<string, unknown>> {
  const [row] = await sql`select * from recording where id = ${recordingId}`;
  const summary = await sql`select * from summary where recording_id = ${recordingId}`;
  const transcript = await sql`select * from transcript where recording_id = ${recordingId}`;
  const segments = await sql`
    select segment.* from segment
    join transcript on transcript.id = segment.transcript_id
    where transcript.recording_id = ${recordingId}
    order by segment.start_ms
  `;
  const jobs = await sql`select * from job where recording_id = ${recordingId} order by id`;
  const progress = await sql`
    select user_id, recording_id, position_ms, updated_at
    from playback_progress where recording_id = ${recordingId} order by user_id
  `;
  return {
    // `series_id` is deliberately dropped: it is the one thing that is *supposed* to move, and
    // leaving it in would make every comparison below fail for the right reason and hide the wrong
    // ones.
    recording: { ...(row as Record<string, unknown>), series_id: undefined },
    summary,
    transcript,
    segments,
    jobs,
    progress,
  };
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 6 });
  sql = postgres(databaseUrl, { max: 3, onnotice: () => {} });

  const asAdmin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'series-admin');
  admin = asAdmin.account;
  adminCookie = asAdmin.cookie;

  const asMember = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'series-member');
  member = asMember.account;
  memberCookie = asMember.cookie;

  secondMember = (await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'series-member-two'))
    .account;
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('an admin creates a series', () => {
  it('writes a title and a description and reads them back', async () => {
    const created = await createSeries(`Created ${RUN}`, 'A verse-by-verse study.');

    expect(created.title).toBe(`Created ${RUN}`);
    expect(created.description).toBe('A verse-by-verse study.');
    expect(created.recordingCount).toBe(0);
    expect(created.firstRecordedAt).toBeNull();

    const listed = (await ours()).find((one) => one.id === created.id);
    expect(listed?.title).toBe(`Created ${RUN}`);
  });

  it('accepts a series with no description at all', async () => {
    const created = await createSeries(`No blurb ${RUN}`);
    expect(created.description).toBeNull();
  });

  it('refuses a blank or missing title before a row exists', async () => {
    const before = (await ours()).length;

    for (const body of [
      JSON.stringify({ title: '   ', description: 'x' }),
      JSON.stringify({ description: 'x' }),
      JSON.stringify({ title: 42 }),
    ]) {
      const refused = await call(SERIES_PATH, { method: 'POST', cookie: adminCookie, body });
      expect(refused.status, body).toBe(400);
      expect(refused.code, body).toBe('invalid_input');
    }

    // The list is what proves nothing was written — an error code alone would not.
    expect((await ours()).length).toBe(before);
  });

  it('lets two series share a title, because a title is not an identifier', async () => {
    const first = await createSeries(`Twins ${RUN}`);
    const second = await createSeries(`Twins ${RUN}`);
    expect(second.id).not.toBe(first.id);
  });
});

describe('an admin renames a series', () => {
  it('rewrites the title and the description and leaves its recordings byte-identical', async () => {
    const created = await createSeries(`Renamed ${RUN}`, 'Before.');
    const first = await newRecording(`In renamed one ${RUN}`, '2026-02-01');
    const second = await newRecording(`In renamed two ${RUN}`, '2026-02-08');

    for (const id of [first, second]) {
      const assigned = await call(recordingSeriesPath(id), {
        method: 'PUT',
        cookie: adminCookie,
        body: JSON.stringify({ seriesId: created.id }),
      });
      expect(assigned.status).toBe(200);
    }

    const before = await Promise.all([snapshot(first), snapshot(second)]);

    const renamed = await call<{ series: SeriesView }>(seriesPath(created.id), {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ title: `Renamed after ${RUN}`, description: 'After.' }),
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.series.title).toBe(`Renamed after ${RUN}`);
    expect(renamed.body.series.description).toBe('After.');

    expect(await Promise.all([snapshot(first), snapshot(second)])).toEqual(before);
  });

  it('refuses a rename of a series that does not exist, and a blank title', async () => {
    const created = await createSeries(`Rename refusals ${RUN}`);

    const nowhere = await call(seriesPath('00000000-0000-0000-0000-000000000000'), {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ title: 'Anything' }),
    });
    expect(nowhere.status).toBe(404);

    const blank = await call(seriesPath(created.id), {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ title: '' }),
    });
    expect(blank.status).toBe(400);
  });
});

describe('an admin assigns, moves and clears a recording`s series', () => {
  it('touches one column and nothing else about the recording', async () => {
    const first = await createSeries(`Move from ${RUN}`);
    const second = await createSeries(`Move to ${RUN}`);
    const recordingId = await newRecording(`Moved intact ${RUN}`, '2026-03-03');

    // **Everything a recording accumulates**, so the comparison below is about a loaded row rather
    // than a bare one — a bare recording would make the transcript and job halves of it vacuously
    // equal, which is exactly the shape of assertion that passes while proving nothing.
    await setRecordingDescription(recordingId, 'What this teaching is about.', handle);
    await publishSummary(recordingId, 'The approved summary.', handle);
    await setSummaryPublication(recordingId, true, handle);
    await setRecordingPublication(recordingId, new Date(), handle);
    await replaceTranscript(
      {
        recordingId,
        language: 'en',
        confidence: 0.94,
        segments: [
          { startMs: 0, endMs: 4_000, text: 'The first line.' },
          { startMs: 4_000, endMs: 9_000, text: 'The second line.' },
        ],
      },
      handle,
    );
    await enqueueJob(
      { recordingId, step: FIRST_PIPELINE_STEP, correlationId: `series-move-${RUN}` },
      handle,
    );

    const before = await snapshot(recordingId);
    // The snapshot is only worth comparing if it actually holds something.
    expect((before['jobs'] as unknown[]).length).toBeGreaterThan(0);
    expect((before['transcript'] as unknown[]).length).toBeGreaterThan(0);
    expect((before['summary'] as unknown[]).length).toBeGreaterThan(0);

    for (const seriesId of [first.id, second.id, null]) {
      const assigned = await call<{ id: string; seriesId: string | null }>(
        recordingSeriesPath(recordingId),
        { method: 'PUT', cookie: adminCookie, body: JSON.stringify({ seriesId }) },
      );
      expect(assigned.status).toBe(200);
      expect(assigned.body.seriesId).toBe(seriesId);
    }

    expect(await snapshot(recordingId)).toEqual(before);

    // And the column really did move each time, so the comparison above is not vacuous.
    await call(recordingSeriesPath(recordingId), {
      method: 'PUT',
      cookie: adminCookie,
      body: JSON.stringify({ seriesId: second.id }),
    });
    const [row] = await sql<{ series_id: string | null }[]>`
      select series_id from recording where id = ${recordingId}
    `;
    expect(row?.series_id).toBe(second.id);
  });

  it('leaves every member`s playback position exactly as it was, across two moves', async () => {
    const first = await createSeries(`Progress from ${RUN}`);
    const second = await createSeries(`Progress to ${RUN}`);
    const recordingId = await newRecording(`Listened to ${RUN}`, '2026-03-04');

    await upsertPlaybackProgress(
      { userId: member.id, recordingId, positionMs: 754_000 },
      handle,
    );
    await upsertPlaybackProgress(
      { userId: secondMember.id, recordingId, positionMs: 91_000 },
      handle,
    );

    const before = await sql`
      select user_id, position_ms, updated_at from playback_progress
      where recording_id = ${recordingId} order by user_id
    `;
    expect(before).toHaveLength(2);

    for (const seriesId of [first.id, second.id]) {
      await call(recordingSeriesPath(recordingId), {
        method: 'PUT',
        cookie: adminCookie,
        body: JSON.stringify({ seriesId }),
      });
    }

    const after = await sql`
      select user_id, position_ms, updated_at from playback_progress
      where recording_id = ${recordingId} order by user_id
    `;
    // Position **and** `updated_at`: a write that merely happened to preserve the number would
    // still have moved the timestamp, and the resume card orders by it.
    expect(after).toEqual(before);
  });

  it('refuses a series that does not exist, and the recording keeps what it had', async () => {
    const held = await createSeries(`Held ${RUN}`);
    const recordingId = await newRecording(`Keeps its series ${RUN}`, '2026-03-05');

    await call(recordingSeriesPath(recordingId), {
      method: 'PUT',
      cookie: adminCookie,
      body: JSON.stringify({ seriesId: held.id }),
    });

    const refused = await call(recordingSeriesPath(recordingId), {
      method: 'PUT',
      cookie: adminCookie,
      body: JSON.stringify({ seriesId: '00000000-0000-0000-0000-000000000000' }),
    });
    expect(refused.status).toBe(404);

    const [row] = await sql<{ series_id: string | null }[]>`
      select series_id from recording where id = ${recordingId}
    `;
    expect(row?.series_id).toBe(held.id);
  });

  it('refuses a recording that does not exist, and a body it cannot read', async () => {
    const nowhere = await call(recordingSeriesPath('00000000-0000-0000-0000-000000000000'), {
      method: 'PUT',
      cookie: adminCookie,
      body: JSON.stringify({ seriesId: null }),
    });
    expect(nowhere.status).toBe(404);

    const recordingId = await newRecording(`Bad assignment body ${RUN}`);
    const malformed = await call(recordingSeriesPath(recordingId), {
      method: 'PUT',
      cookie: adminCookie,
      body: JSON.stringify({ seriesId: 7 }),
    });
    expect(malformed.status).toBe(400);
  });
});

describe('the console`s list', () => {
  it('includes a series with no recordings at all, with a count of zero and no range', async () => {
    const created = await createSeries(`Console empty ${RUN}`);
    const listed = (await ours()).find((one) => one.id === created.id);

    expect(listed?.recordingCount).toBe(0);
    expect(listed?.firstRecordedAt).toBeNull();
    expect(listed?.lastRecordedAt).toBeNull();
  });

  it('counts unpublished recordings, which the member surface does not', async () => {
    const created = await createSeries(`Console counted ${RUN}`);
    const published = await newRecording(`Console published ${RUN}`, '2026-01-05');
    const hidden = await newRecording(`Console hidden ${RUN}`, '2026-07-25');

    for (const id of [published, hidden]) {
      await call(recordingSeriesPath(id), {
        method: 'PUT',
        cookie: adminCookie,
        body: JSON.stringify({ seriesId: created.id }),
      });
    }
    await setRecordingPublication(published, new Date(), handle);

    const listed = (await ours()).find((one) => one.id === created.id);
    expect(listed?.recordingCount).toBe(2);
    expect(listed?.lastRecordedAt).toBe('2026-07-25');
  });
});

describe('a member is refused every series write, by the API', () => {
  it('refuses create, rename and assign with a real session', async () => {
    const created = await createSeries(`Member refused ${RUN}`);
    const recordingId = await newRecording(`Member cannot assign ${RUN}`);
    const before = (await ours()).length;

    const attempts = [
      await call(SERIES_PATH, {
        method: 'POST',
        cookie: memberCookie,
        body: JSON.stringify({ title: `Member made this ${RUN}` }),
      }),
      await call(seriesPath(created.id), {
        method: 'PATCH',
        cookie: memberCookie,
        body: JSON.stringify({ title: `Member renamed this ${RUN}` }),
      }),
      await call(recordingSeriesPath(recordingId), {
        method: 'PUT',
        cookie: memberCookie,
        body: JSON.stringify({ seriesId: created.id }),
      }),
    ];

    for (const attempt of attempts) {
      // `forbidden`, not `unauthenticated`: the session is real and the account is not permitted.
      expect(attempt.status).toBe(403);
      expect(attempt.code).toBe('forbidden');
    }

    // Nothing was created, nothing was renamed, nothing was assigned.
    expect((await ours()).length).toBe(before);
    expect((await ours()).find((one) => one.id === created.id)?.title).toBe(
      `Member refused ${RUN}`,
    );
    const [row] = await sql<{ series_id: string | null }[]>`
      select series_id from recording where id = ${recordingId}
    `;
    expect(row?.series_id).toBeNull();
  });

  it('refuses a member the console`s list, and answers them the member surface', async () => {
    // `series.list` is admin-only; `series.browse` is not. A member asking for the console's shape
    // still gets a member's rows, because the policy answers that question and the parameter never
    // does.
    const listed = await call<SeriesListPayload>(SERIES_PATH, { cookie: memberCookie });
    expect(listed.status).toBe(200);
    expect(listed.body.series.some((one) => one.title === `Console empty ${RUN}`)).toBe(false);
  });

  it('refuses an anonymous caller on every series route', async () => {
    const created = await createSeries(`Anonymous ${RUN}`);
    for (const [path, method] of [
      [SERIES_PATH, 'GET'],
      [SERIES_PATH, 'POST'],
      [seriesPath(created.id), 'GET'],
      [seriesPath(created.id), 'PATCH'],
      [recordingSeriesPath(await newRecording(`Anonymous assign ${RUN}`)), 'PUT'],
    ] as const) {
      const refused = await call(path, {
        method,
        ...(method === 'GET' ? {} : { body: JSON.stringify({}) }),
      });
      expect(refused.status, `${method} ${path}`).toBe(401);
      expect(refused.code, `${method} ${path}`).toBe('unauthenticated');
    }
  });
});

describe('every series write is logged', () => {
  it('records actor, action, target and timestamp under the request`s correlation id', async () => {
    const offset = logOffset(logPath);

    const created = await createSeries(`Logged ${RUN}`);
    const recordingId = await newRecording(`Logged assignment ${RUN}`);
    await call(seriesPath(created.id), {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ title: `Logged renamed ${RUN}` }),
    });
    await call(recordingSeriesPath(recordingId), {
      method: 'PUT',
      cookie: adminCookie,
      body: JSON.stringify({ seriesId: created.id }),
    });

    const wanted = ['series.create', 'series.update', 'series.assign'];
    const lines = await waitForLogLines(logPath, offset, (found) =>
      wanted.every((message) => found.some((line) => line.message === message)),
    );

    for (const message of wanted) {
      const line = lines.find(
        (one) => one.message === message && one['target'] === `series:${created.id}`,
      );
      expect(line, message).toBeDefined();
      expect(line).toMatchObject({ actorId: admin.id, actorEmail: admin.email, action: message });
      expect(typeof line?.time).toBe('string');
      expect(typeof line?.correlationId).toBe('string');
    }
  }, 60_000);
});
