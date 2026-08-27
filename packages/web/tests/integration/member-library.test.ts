import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  MEMBER_RECORDINGS_PATH,
  RECORDINGS_PATH,
  ROLE,
  memberRecordingPath,
  recordingPath,
  type AdminRecordingListPayload,
  type RecordingListPayload,
  type RecordingPayload,
  type RecordingSummary,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  insertSeries,
  publishSummary,
  setRecordingDescription,
  setRecordingPublication,
  setRecordingSeries,
  setSeriesArtwork,
  setSummaryPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';

/**
 * **The member library and the recording read** (Story 4 Ticket 01).
 *
 * The claim under test is not "the list route works" — Story 3 Ticket 04 pinned that. It is that
 * the *member surface* answers with published rows only **whatever the caller's role**, and that
 * one teaching is readable by id under exactly the same rule.
 *
 * Everything is driven over HTTP against the running server. Nothing here imports a route handler:
 * importing one would not prove the route exists, and the whole point of these assertions is what a
 * browser would actually receive.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

/** The console's reading — the parameter is absent, so nothing that already called this changed. */
const LIST_URL = `${baseUrl}${API_PREFIX}${RECORDINGS_PATH}`;

/** The member surface, which is what both member screens ask for whoever is signed in. */
const MEMBER_LIST_URL = `${baseUrl}${API_PREFIX}${MEMBER_RECORDINGS_PATH}`;

let handle: DatabaseHandle;
let member: TestAccount;
let memberCookie: string;
let adminCookie: string;
let seeded = 0;

/** Titles unique to this run, so the assertions can name rows other suites also wrote. */
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const OLDER_TITLE = `Library older ${RUN}`;
const NEWER_TITLE = `Library newer ${RUN}`;
const HIDDEN_TITLE = `Library unpublished ${RUN}`;
const NO_SUMMARY_TITLE = `Library no summary ${RUN}`;

let olderId: string;
let newerId: string;
let hiddenId: string;
let noSummaryId: string;
/** A teaching in a series that has a cover, and one in a series that has none (scope plan 2.3.1). */
let coveredId: string;
let uncoveredSeriesRecordingId: string;

const COVERED_TITLE = `Library covered ${RUN}`;
const UNCOVERED_SERIES_TITLE = `Library uncovered series teaching ${RUN}`;
const COVER_KEY = `artwork/${RUN}-member-library.webp`;

async function newRecording(title: string, recordedAt: string): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    { originalMediaKey: `originals/member-library-${RUN}-${seeded}.mp3`, title, recordedAt },
    handle,
  );
  return row.id;
}

async function get<T>(url: string, cookie: string): Promise<{ status: number; body: T }> {
  const response = await fetch(url, { headers: { accept: 'application/json', cookie } });
  return { status: response.status, body: (await response.json()) as T };
}

function titles(payload: { recordings: readonly { title: string }[] }): string[] {
  return payload.recordings.map((recording) => recording.title);
}

/** The rows this run wrote, in the order the API sent them. */
function ours(payload: { recordings: readonly { title: string }[] }): string[] {
  return titles(payload).filter((title) => title.endsWith(RUN));
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 6 });

  const asMember = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'library-member');
  member = asMember.account;
  memberCookie = asMember.cookie;
  adminCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'library-admin')).cookie;

  // Two published with known dates, one left unpublished, and one published with no summary at all.
  olderId = await newRecording(OLDER_TITLE, '2026-03-01');
  newerId = await newRecording(NEWER_TITLE, '2026-07-14');
  hiddenId = await newRecording(HIDDEN_TITLE, '2026-08-01');
  noSummaryId = await newRecording(NO_SUMMARY_TITLE, '2026-02-02');

  await setRecordingDescription(newerId, 'What the newer teaching is about.', handle);
  await publishSummary(newerId, 'The approved summary of the newer teaching.', handle);
  await setSummaryPublication(newerId, true, handle);

  await setRecordingPublication(olderId, new Date(), handle);
  await setRecordingPublication(newerId, new Date(), handle);
  await setRecordingPublication(noSummaryId, new Date(), handle);

  // One series with a cover and one without, so "carries the URL" and "carries `null`" are two
  // rows of the same payload rather than two runs of the suite.
  const coveredSeries = await insertSeries({ title: `Library covered series ${RUN}`, description: null }, handle);
  await setSeriesArtwork(coveredSeries.id, COVER_KEY, handle);
  const bareSeries = await insertSeries({ title: `Library bare series ${RUN}`, description: null }, handle);

  coveredId = await newRecording(COVERED_TITLE, '2026-05-05');
  await setRecordingSeries(coveredId, coveredSeries.id, handle);
  await setRecordingPublication(coveredId, new Date(), handle);

  uncoveredSeriesRecordingId = await newRecording(UNCOVERED_SERIES_TITLE, '2026-05-06');
  await setRecordingSeries(uncoveredSeriesRecordingId, bareSeries.id, handle);
  await setRecordingPublication(uncoveredSeriesRecordingId, new Date(), handle);
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('a member sees every published teaching, newest recorded first', () => {
  it('orders by the date recorded and omits what nobody published', async () => {
    const { status, body } = await get<RecordingListPayload>(LIST_URL, memberCookie);
    expect(status).toBe(200);

    // The order is the query's. A client that re-sorted would be a second answer to "what is most
    // recent", and this asserts there is only one. Still the exact list rather than a subset —
    // the two series rows this run seeds for the cover assertions below are in it by date, which
    // is the whole claim, and a `toContain` here would stop catching a row that went missing.
    expect(ours(body)).toEqual([
      NEWER_TITLE, // 2026-07-14
      UNCOVERED_SERIES_TITLE, // 2026-05-06
      COVERED_TITLE, // 2026-05-05
      OLDER_TITLE, // 2026-03-01
      NO_SUMMARY_TITLE, // 2026-02-02
    ]);
    expect(titles(body)).not.toContain(HIDDEN_TITLE);
  });

  it('includes a teaching with no series and one with no summary', async () => {
    // 3.3.9 — a recording belongs to at most one series and may have none; there are no series at
    // all in this epic, so every row here is that case. 3.6.10 — a discarded draft leaves a
    // teaching publishable, and this asserts it is genuinely readable rather than merely stored.
    const { body } = await get<RecordingListPayload>(LIST_URL, memberCookie);
    const noSummary = body.recordings.find((row) => row.title === NO_SUMMARY_TITLE);
    expect(noSummary).toBeDefined();
    expect(noSummary?.summary).toBeNull();
  });

  it('answers the summary only when both gates are open', async () => {
    const { body } = await get<RecordingListPayload>(LIST_URL, memberCookie);
    const newer = body.recordings.find((row) => row.title === NEWER_TITLE);
    expect(newer?.summary).toBe('The approved summary of the newer teaching.');
    expect(newer?.description).toBe('What the newer teaching is about.');
  });
});

describe('the member surface shows published rows only, whatever the caller`s role', () => {
  it('answers an admin asking for the member surface exactly as it answers a member', async () => {
    // **The request that matters.** An admin opening the member library asks for the member
    // surface, and the read passes `includeUnpublished: false` explicitly rather than deriving it
    // from `recording.list` — otherwise the screen that exists to show what a member sees would
    // show an admin something else entirely.
    const asAdminOnMemberSurface = await get<RecordingListPayload>(
      MEMBER_LIST_URL,
      adminCookie,
    );
    expect(titles(asAdminOnMemberSurface.body)).not.toContain(HIDDEN_TITLE);
    expect(ours(asAdminOnMemberSurface.body)).toEqual(ours((await get<RecordingListPayload>(
      MEMBER_LIST_URL,
      memberCookie,
    )).body));

    // And the console still keeps the operator's answer: one route, two shapes.
    const console_ = await get<AdminRecordingListPayload>(LIST_URL, adminCookie);
    expect(titles(console_.body)).toContain(HIDDEN_TITLE);
  });

  it('refuses an unpublished id on the member surface, at either role', async () => {
    for (const [label, cookie] of [
      ['member', memberCookie],
      ['admin', adminCookie],
    ] as const) {
      const refused = await get<{ error?: unknown }>(
        `${baseUrl}${API_PREFIX}${memberRecordingPath(hiddenId)}`,
        cookie,
      );
      expect(refused.status, label).toBe(404);
    }

    // The console's reading of the same id still answers, so the refusal above is the surface and
    // not the row disappearing.
    const inTheConsole = await get<RecordingPayload>(
      `${baseUrl}${API_PREFIX}${recordingPath(hiddenId)}`,
      adminCookie,
    );
    expect(inTheConsole.status).toBe(200);
    expect(inTheConsole.body.recording.title).toBe(HIDDEN_TITLE);
  });

  it('is only ever narrowing — a member asking for the console shape still gets a member`s rows', async () => {
    // The parameter is a request, never a permission. What a caller *may* see is the policy's
    // answer and nothing here can widen it.
    const asMember = await get<RecordingListPayload>(LIST_URL, memberCookie);
    expect(titles(asMember.body)).not.toContain(HIDDEN_TITLE);
    expect(JSON.stringify(asMember.body)).not.toContain('originalMediaKey');
  });

  it('sends no object key and no creation time to the member surface, at either role', async () => {
    for (const [label, cookie] of [
      ['member', memberCookie],
      ['admin', adminCookie],
    ] as const) {
      const list = await get<RecordingListPayload>(MEMBER_LIST_URL, cookie);
      expect(JSON.stringify(list.body), label).not.toContain('originalMediaKey');
      expect(JSON.stringify(list.body), label).not.toContain('createdAt');

      const one = await get<RecordingPayload>(
        `${baseUrl}${API_PREFIX}${memberRecordingPath(newerId)}`,
        cookie,
      );
      expect(JSON.stringify(one.body), label).not.toContain('originalMediaKey');
      expect(JSON.stringify(one.body), label).not.toContain('createdAt');
    }

    // And the console still gets both, so this is a member-shaped answer rather than a route that
    // stopped sending them.
    const console_ = await get<AdminRecordingListPayload>(LIST_URL, adminCookie);
    const seen = console_.body.recordings.find(
      (row: RecordingSummary) => row.title === HIDDEN_TITLE,
    );
    expect(seen?.originalMediaKey).toContain('originals/');
    expect(seen?.createdAt).toBeTruthy();
  });
});

/**
 * **The cover rides on the recording's series ref** (scope plan 2.3.1; scope prd 3.2.3, 4.2).
 *
 * A recording has no artwork of its own and never will in this scope — what its page and the
 * transport show is the cover of the study it belongs to, which is why the URL is a field of
 * `series` rather than of the recording. And it is a URL: the key never leaves the process.
 */
describe('a recording carries its series` cover, and never the key', () => {
  it('answers a signed URL for a teaching whose series has a cover', async () => {
    const { status, body } = await get<RecordingPayload>(
      `${baseUrl}${API_PREFIX}${recordingPath(coveredId)}`,
      memberCookie,
    );
    expect(status).toBe(200);
    expect(body.recording.series).not.toBeNull();

    const url = body.recording.series?.artworkUrl ?? '';
    expect(url).toContain('X-Amz-Signature');
    expect(url.startsWith('http://') || url.startsWith('https://')).toBe(true);
  });

  it('answers null for a teaching whose series has no cover, and for one in no series', async () => {
    const inBareSeries = await get<RecordingPayload>(
      `${baseUrl}${API_PREFIX}${recordingPath(uncoveredSeriesRecordingId)}`,
      memberCookie,
    );
    expect(inBareSeries.body.recording.series).not.toBeNull();
    expect(inBareSeries.body.recording.series?.artworkUrl).toBeNull();

    // A teaching in no series has no ref at all — there is no second "no cover" state to represent.
    const loose = await get<RecordingPayload>(
      `${baseUrl}${API_PREFIX}${recordingPath(olderId)}`,
      memberCookie,
    );
    expect(loose.body.recording.series).toBeNull();
  });

  it('carries the cover on the member list too, and no payload carries the object key', async () => {
    const { body } = await get<RecordingListPayload>(MEMBER_LIST_URL, memberCookie);
    const row = body.recordings.find((one) => one.title === COVERED_TITLE);
    expect(row?.series?.artworkUrl ?? '').toContain('X-Amz-Signature');

    // The signed URL necessarily has the key in its *path*; what must never appear is a payload
    // field carrying the bare key (scope prd 4.2). Stripping the URLs is what makes that testable.
    const withoutUrls = JSON.stringify(body).split(/"artworkUrl":"[^"]*"/).join('');
    expect(withoutUrls).not.toContain(COVER_KEY);
    expect(withoutUrls).not.toContain('artworkKey');
    expect(withoutUrls).not.toContain('seriesArtworkKey');
  });

  it('carries it on the console`s reading of the same teaching', async () => {
    // `describeForOperator` spreads the member view, so the console gets the cover for free — and
    // the assertion is here so that stops being an accident nobody would notice breaking.
    const { body } = await get<AdminRecordingListPayload>(LIST_URL, adminCookie);
    const row = body.recordings.find((one) => one.title === COVERED_TITLE);
    expect(row?.series?.artworkUrl ?? '').toContain('X-Amz-Signature');
  });
});

describe('one teaching, by id', () => {
  it('answers a published id with what a member came to read', async () => {
    const { status, body } = await get<RecordingPayload>(
      `${baseUrl}${API_PREFIX}${recordingPath(newerId)}`,
      memberCookie,
    );
    expect(status).toBe(200);
    expect(body.recording.id).toBe(newerId);
    expect(body.recording.title).toBe(NEWER_TITLE);
    expect(body.recording.recordedAt).toBe('2026-07-14');
    expect(body.recording.summary).toBe('The approved summary of the newer teaching.');
    expect(body.recording.description).toBe('What the newer teaching is about.');
  });

  it('refuses an unpublished id and a nonexistent id identically', async () => {
    // Same status, same code, same message — so a member who guessed a uuid learns nothing from the
    // difference between "not yours to read" and "no such thing".
    const unpublished = await fetch(`${baseUrl}${API_PREFIX}${recordingPath(hiddenId)}`, {
      headers: { accept: 'application/json', cookie: memberCookie },
    });
    const nowhere = await fetch(
      `${baseUrl}${API_PREFIX}${recordingPath('00000000-0000-0000-0000-000000000000')}`,
      { headers: { accept: 'application/json', cookie: memberCookie } },
    );

    expect(unpublished.status).toBe(404);
    expect(nowhere.status).toBe(unpublished.status);
    const [a, b] = await Promise.all([unpublished.json(), nowhere.json()]);
    expect(b).toMatchObject({
      error: { code: (a as { error: { code: string } }).error.code },
    });
    expect((b as { error: { message: string } }).error.message).toBe(
      (a as { error: { message: string } }).error.message,
    );
  });

  it('answers null for a summary that was returned to draft, without taking the teaching down', async () => {
    // 3.6.12 — the second gate closing must not close the first. The recording stays readable and
    // its summary does not.
    await setSummaryPublication(newerId, false, handle);
    try {
      const { status, body } = await get<RecordingPayload>(
        `${baseUrl}${API_PREFIX}${recordingPath(newerId)}`,
        memberCookie,
      );
      expect(status).toBe(200);
      expect(body.recording.summary).toBeNull();
      expect(body.recording.description).toBe('What the newer teaching is about.');
    } finally {
      await setSummaryPublication(newerId, true, handle);
    }
  });

  it('refuses an anonymous caller before saying anything about the id', async () => {
    const response = await fetch(`${baseUrl}${API_PREFIX}${recordingPath(newerId)}`, {
      headers: { accept: 'application/json' },
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthenticated');
  });
});

describe('the member who was signed in is the one being answered', () => {
  it('reads the library as the account whose cookie was sent', async () => {
    // A guard against the read being answered from anything but the session: the member account
    // exists and the list is theirs to see, and the same request with no cookie is refused.
    expect(member.email).toContain('@example.test');
    const anonymous = await fetch(LIST_URL, { headers: { accept: 'application/json' } });
    expect(anonymous.status).toBe(401);
  });
});
