import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  MEMBER_SERIES_PATH,
  ROLE,
  SERIES_PATH,
  memberRecordingPath,
  memberSeriesPath,
  seriesPath,
  type RecordingPayload,
  type SeriesListPayload,
  type SeriesPayload,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  insertSeries,
  setRecordingDescription,
  setRecordingPublication,
  setRecordingSeries,
  setSeriesArtwork,
  upsertPlaybackProgress,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';

/**
 * **The member series view** (Story 6 Ticket 02), driven over HTTP against the running server.
 *
 * Four claims, and each is written from the *member's* side rather than the query's:
 *
 * 1. A member sees series holding at least one published recording, and no other.
 * 2. Count and date range are over published recordings only, and they move when a recording is
 *    published or taken back down.
 * 3. A series opens oldest-recorded first, and an unpublished recording in it is simply absent.
 * 4. The progress on a row is the requesting member's and never anybody else's.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let handle: DatabaseHandle;
let memberCookie: string;
let member: TestAccount;
let otherCookie: string;
let other: TestAccount;
let adminCookie: string;
let seeded = 0;

/** A series with one published recording — the ordinary case. */
let liveSeriesId: string;
/** A series whose only recording is unpublished. */
let hiddenSeriesId: string;
/** A series with no recordings at all. */
let emptySeriesId: string;
/** The three-recording series the order and the numbering are asserted against. */
let orderedSeriesId: string;
let firstId: string;
let middleId: string;
let lastId: string;
let unpublishedInOrderedId: string;
/** The recording two members have both listened to. */
let sharedId: string;
/** The one recording whose publication this file turns off and on again. */
let toggledId: string;

async function get<T>(path: string, cookie: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    headers: { accept: 'application/json', cookie },
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function newRecording(
  title: string,
  recordedAt: string,
  seriesId: string | null,
  published: boolean,
): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    { originalMediaKey: `originals/series-browse-${RUN}-${seeded}.mp3`, title, recordedAt },
    handle,
  );
  if (seriesId !== null) await setRecordingSeries(row.id, seriesId, handle);
  if (published) await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

/** The series this run wrote, in the order the API sent them. */
function ours(payload: SeriesListPayload): string[] {
  return payload.series.map((one) => one.title).filter((title) => title.endsWith(RUN));
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 6 });

  const asMember = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'browse-member');
  member = asMember.account;
  memberCookie = asMember.cookie;

  const asOther = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'browse-other');
  other = asOther.account;
  otherCookie = asOther.cookie;

  adminCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'browse-admin')).cookie;

  liveSeriesId = (await insertSeries({ title: `Live series ${RUN}`, description: 'A study.' }, handle))
    .id;
  hiddenSeriesId = (await insertSeries({ title: `Hidden series ${RUN}`, description: null }, handle))
    .id;
  emptySeriesId = (await insertSeries({ title: `Empty series ${RUN}`, description: null }, handle)).id;
  orderedSeriesId = (
    await insertSeries({ title: `Ordered series ${RUN}`, description: 'Read forwards.' }, handle)
  ).id;

  sharedId = await newRecording(`Live shared ${RUN}`, '2026-04-10', liveSeriesId, true);
  await setRecordingDescription(sharedId, 'What the live teaching is about.', handle);
  await newRecording(`Hidden only ${RUN}`, '2026-04-11', hiddenSeriesId, false);

  // Deliberately out of insertion order, so "oldest recorded first" cannot pass by accident.
  middleId = await newRecording(`Ordered middle ${RUN}`, '2026-02-15', orderedSeriesId, true);
  lastId = await newRecording(`Ordered last ${RUN}`, '2026-06-04', orderedSeriesId, true);
  firstId = await newRecording(`Ordered first ${RUN}`, '2026-01-12', orderedSeriesId, true);
  unpublishedInOrderedId = await newRecording(
    `Ordered unpublished ${RUN}`,
    '2026-03-30',
    orderedSeriesId,
    false,
  );

  toggledId = await newRecording(`Toggled ${RUN}`, '2026-05-20', liveSeriesId, true);

  await upsertPlaybackProgress({ userId: member.id, recordingId: sharedId, positionMs: 754_000 }, handle);
  await upsertPlaybackProgress({ userId: other.id, recordingId: sharedId, positionMs: 12_000 }, handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('a member sees the series worth opening, and no other', () => {
  it('omits a series whose only recording is unpublished, and one with none', async () => {
    const { status, body } = await get<SeriesListPayload>(MEMBER_SERIES_PATH, memberCookie);
    expect(status).toBe(200);

    const titles = ours(body);
    expect(titles).toContain(`Live series ${RUN}`);
    expect(titles).toContain(`Ordered series ${RUN}`);
    expect(titles).not.toContain(`Hidden series ${RUN}`);
    expect(titles).not.toContain(`Empty series ${RUN}`);
  });

  it('answers an admin on the member surface exactly as it answers a member', async () => {
    const asAdmin = await get<SeriesListPayload>(MEMBER_SERIES_PATH, adminCookie);
    const asMember = await get<SeriesListPayload>(MEMBER_SERIES_PATH, memberCookie);
    expect(ours(asAdmin.body)).toEqual(ours(asMember.body));

    // And the console keeps the operator's answer, so the above is the surface rather than the
    // rows disappearing.
    const console_ = await get<SeriesListPayload>(SERIES_PATH, adminCookie);
    expect(ours(console_.body)).toContain(`Empty series ${RUN}`);
    expect(ours(console_.body)).toContain(`Hidden series ${RUN}`);
  });

  it('orders by the most recent published recording, newest first', async () => {
    const { body } = await get<SeriesListPayload>(MEMBER_SERIES_PATH, memberCookie);
    const titles = ours(body);
    // `Live series` runs to 20 May 2026; `Ordered series` runs to 4 Jun 2026.
    expect(titles.indexOf(`Ordered series ${RUN}`)).toBeLessThan(
      titles.indexOf(`Live series ${RUN}`),
    );
  });
});

describe('a series carries its count and date range, over published recordings only', () => {
  it('counts two of three and spans only those two', async () => {
    const { body } = await get<SeriesListPayload>(MEMBER_SERIES_PATH, memberCookie);
    const ordered = body.series.find((one) => one.title === `Ordered series ${RUN}`);

    // Three published, one not. The unpublished 30 Mar recording is inside the range, so a count
    // that included it would still produce the same dates — which is why the count is asserted too.
    expect(ordered?.recordingCount).toBe(3);
    expect(ordered?.firstRecordedAt).toBe('2026-01-12');
    expect(ordered?.lastRecordedAt).toBe('2026-06-04');

    const console_ = await get<SeriesListPayload>(SERIES_PATH, adminCookie);
    const asOperator = console_.body.series.find((one) => one.title === `Ordered series ${RUN}`);
    expect(asOperator?.recordingCount).toBe(4);
  });

  it('drops a series when its last published recording is taken down, and restores it', async () => {
    // Two published recordings sit in `Live series`; taking both down empties it for a member.
    await setRecordingPublication(sharedId, null, handle);
    await setRecordingPublication(toggledId, null, handle);
    try {
      const down = await get<SeriesListPayload>(MEMBER_SERIES_PATH, memberCookie);
      expect(ours(down.body)).not.toContain(`Live series ${RUN}`);

      // Nothing was deleted: the console still has it, with both recordings in it.
      const console_ = await get<SeriesListPayload>(SERIES_PATH, adminCookie);
      expect(
        console_.body.series.find((one) => one.title === `Live series ${RUN}`)?.recordingCount,
      ).toBe(2);
    } finally {
      await setRecordingPublication(sharedId, new Date(), handle);
      await setRecordingPublication(toggledId, new Date(), handle);
    }

    const back = await get<SeriesListPayload>(MEMBER_SERIES_PATH, memberCookie);
    expect(ours(back.body)).toContain(`Live series ${RUN}`);
  });
});

describe('one series, opened', () => {
  it('lists its published recordings oldest recorded first', async () => {
    const { status, body } = await get<SeriesPayload>(
      memberSeriesPath(orderedSeriesId),
      memberCookie,
    );
    expect(status).toBe(200);

    expect(body.recordings.map((one) => one.id)).toEqual([firstId, middleId, lastId]);
    expect(body.recordings.map((one) => one.recordedAt)).toEqual([
      '2026-01-12',
      '2026-02-15',
      '2026-06-04',
    ]);
    // Forwards, and therefore the opposite of the library — which orders the same rows the other
    // way. Both are correct: a library is newest-first, a study is read forwards.
    expect(body.recordings.map((one) => one.title)).not.toContain(`Ordered unpublished ${RUN}`);

    expect(body.series.title).toBe(`Ordered series ${RUN}`);
    expect(body.series.description).toBe('Read forwards.');
    expect(body.series.recordingCount).toBe(3);
  });

  it('answers an unpublished recording`s series without it, whatever the caller`s role', async () => {
    // The member surface is the member surface. An admin asking for it does not get the console's
    // rows, because the read passes `includeUnpublished: false` explicitly rather than deriving it.
    const asAdmin = await get<SeriesPayload>(memberSeriesPath(orderedSeriesId), adminCookie);
    expect(asAdmin.body.recordings.map((one) => one.id)).not.toContain(unpublishedInOrderedId);
    expect(asAdmin.body.recordings).toHaveLength(3);

    // The console's reading of the same id does include it, so the absence above is the surface.
    const console_ = await get<SeriesPayload>(seriesPath(orderedSeriesId), adminCookie);
    expect(console_.body.recordings.map((one) => one.id)).toContain(unpublishedInOrderedId);
  });

  it('refuses a series holding nothing visible exactly as one that never existed', async () => {
    const hidden = await fetch(`${baseUrl}${API_PREFIX}${memberSeriesPath(hiddenSeriesId)}`, {
      headers: { accept: 'application/json', cookie: memberCookie },
    });
    const nowhere = await fetch(
      `${baseUrl}${API_PREFIX}${memberSeriesPath('00000000-0000-0000-0000-000000000000')}`,
      { headers: { accept: 'application/json', cookie: memberCookie } },
    );

    expect(hidden.status).toBe(404);
    expect(nowhere.status).toBe(hidden.status);

    const [a, b] = (await Promise.all([hidden.json(), nowhere.json()])) as {
      error: { code: string; message: string };
    }[];
    // Same code and same message — so a member who guessed a uuid learns nothing from the
    // difference between "not yours to read" and "no such thing".
    expect(b?.error.code).toBe(a?.error.code);
    expect(b?.error.message).toBe(a?.error.message);
  });

  it('refuses an empty series to a member and answers it to the console', async () => {
    const refused = await get(memberSeriesPath(emptySeriesId), memberCookie);
    expect(refused.status).toBe(404);

    const console_ = await get<SeriesPayload>(seriesPath(emptySeriesId), adminCookie);
    expect(console_.status).toBe(200);
    expect(console_.body.recordings).toHaveLength(0);
  });
});

describe('progress on a series row is the reader`s own', () => {
  it('answers each member their own position and never the other`s', async () => {
    const mine = await get<SeriesPayload>(memberSeriesPath(liveSeriesId), memberCookie);
    const theirs = await get<SeriesPayload>(memberSeriesPath(liveSeriesId), otherCookie);

    expect(mine.body.recordings.find((one) => one.id === sharedId)?.positionMs).toBe(754_000);
    expect(theirs.body.recordings.find((one) => one.id === sharedId)?.positionMs).toBe(12_000);

    // Neither payload carries the other member's number anywhere in it.
    expect(JSON.stringify(mine.body)).not.toContain('12000');
    expect(JSON.stringify(theirs.body)).not.toContain('754000');
  });

  it('answers null for a recording this member has never started', async () => {
    const mine = await get<SeriesPayload>(memberSeriesPath(orderedSeriesId), memberCookie);
    expect(mine.body.recordings.every((one) => one.positionMs === null)).toBe(true);
  });

  it('reads the position and never writes one', async () => {
    // Opening a series must not create a resume point for anybody in it.
    const before = await get<SeriesPayload>(memberSeriesPath(orderedSeriesId), otherCookie);
    await get<SeriesPayload>(memberSeriesPath(orderedSeriesId), otherCookie);
    const after = await get<SeriesPayload>(memberSeriesPath(orderedSeriesId), otherCookie);
    expect(after.body.recordings).toEqual(before.body.recordings);
    expect(after.body.recordings.every((one) => one.positionMs === null)).toBe(true);
  });
});

describe('a recording carries the series it belongs to', () => {
  it('names it on the member surface, and answers null for a recording in none', async () => {
    const inSeries = await get<RecordingPayload>(memberRecordingPath(sharedId), memberCookie);
    expect(inSeries.body.recording.series).toEqual({
      id: liveSeriesId,
      title: `Live series ${RUN}`,
    });

    const loose = await newRecording(`No series at all ${RUN}`, '2026-05-21', null, true);
    const alone = await get<RecordingPayload>(memberRecordingPath(loose), memberCookie);
    expect(alone.body.recording.series).toBeNull();
  });
});

describe('a series carries its cover, as a grant rather than a key', () => {
  /** Written straight at the database: what is under test here is the *read*, not the upload. */
  const COVER_KEY = `artwork/browse-${RUN}.webp`;

  beforeAll(async () => {
    await setSeriesArtwork(liveSeriesId, COVER_KEY, handle);
  }, 60_000);

  it('answers artworkUrl on the member series list', async () => {
    // scope plan 1.3.2. A member reads a cover on the listing exactly as the console does — the
    // URL is minted for the response after the same policy check the rest of the row passed.
    const list = await get<SeriesListPayload>(MEMBER_SERIES_PATH, memberCookie);
    const covered = list.body.series.find((one) => one.id === liveSeriesId);

    expect(covered?.artworkUrl).toContain('X-Amz-Signature');
    expect(covered?.artworkUrl).toContain(COVER_KEY);
  });

  it('answers artworkUrl on the series detail payload', async () => {
    // scope plan 1.3.3.
    const detail = await get<SeriesPayload>(memberSeriesPath(liveSeriesId), memberCookie);

    expect(detail.body.series.artworkUrl).toContain('X-Amz-Signature');
    expect(detail.body.series.artworkUrl).toContain(COVER_KEY);
  });

  it('answers null on both for a series nobody has covered', async () => {
    const list = await get<SeriesListPayload>(MEMBER_SERIES_PATH, memberCookie);
    const uncovered = list.body.series.find((one) => one.id === orderedSeriesId);
    const detail = await get<SeriesPayload>(memberSeriesPath(orderedSeriesId), memberCookie);

    expect(uncovered?.artworkUrl).toBeNull();
    expect(detail.body.series.artworkUrl).toBeNull();
  });
});
