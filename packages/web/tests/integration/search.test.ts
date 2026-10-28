import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  MEANING_LABELS,
  ROLE,
  SEARCH_BUDGET_PER_HOUR,
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  SEARCH_PAGE_SIZE,
  meaningLabel,
  searchPath,
  type ApiErrorBody,
  type SearchPayload,
} from '@thp/shared';
import {
  createDatabase,
  insertNote,
  insertRecording,
  insertSeries,
  listSegments,
  replaceTranscript,
  setRecordingPublication,
  setRecordingSeries,
  upsertEmbeddings,
  type DatabaseHandle,
} from '@thp/db';
import { fakeVector } from '@thp/embed';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';

/**
 * **`GET /api/v1/search`, end to end** ([3.10](docs/project/prd.md)): the route, the budget, and
 * the payload the page prints — against the real server, whose embedder is the fake.
 *
 * The query's own properties — visibility inside the top-k, the blend, the per-teaching cap, the
 * paging, the fusion order — are proved in `packages/db/tests/integration/search.test.ts`. What
 * this file pins is the layer on top: who may call, what a bad address is refused with, that a
 * hit carries what the page needs to go somewhere and to say how it matched, that the scores are
 * disclosed to an admin and to nobody else, that "Words only" spends no provider call, and that
 * the sixty-first search in an hour is refused with a wait.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const LINE = `The search route finds this line ${RUN}.`;

let handle: DatabaseHandle;
let member: TestAccount;
let cookie: string;
let recordingId: string;
let seriesId: string;
let segmentId: string;
let myNoteId: string;

async function get<T>(path: string, as: string | null): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    headers: { accept: 'application/json', ...(as === null ? {} : { cookie: as }) },
  });
  return { status: response.status, body: (await response.json()) as T };
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
  const signedIn = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'search-member');
  member = signedIn.account;
  cookie = signedIn.cookie;

  seriesId = (await insertSeries({ title: `Search series ${RUN}`, description: null }, handle)).id;
  const row = await insertRecording(
    { originalMediaKey: `originals/search-route-${RUN}.mp3`, title: `Search teaching ${RUN}`, recordedAt: '2026-09-09' },
    handle,
  );
  recordingId = row.id;
  await setRecordingSeries(recordingId, seriesId, handle);
  const transcript = await replaceTranscript(
    {
      recordingId,
      language: 'en',
      confidence: 0.9,
      segments: [
        { startMs: 0, endMs: 5_000, text: 'An opening line.' },
        { startMs: 5_000, endMs: 10_000, text: LINE },
      ],
    },
    handle,
  );
  const segments = await listSegments(transcript.id, handle);
  segmentId = segments[1]?.id ?? '';
  const note = await insertNote(
    { recordingId, authorId: member.id, visibility: 'public', timestampMs: 5_000, text: `My note about ${RUN}.` },
    handle,
  );
  myNoteId = note.id;
  await upsertEmbeddings(
    [
      ...segments.map((segment) => ({
        sourceKind: 'segment' as const,
        sourceId: segment.id,
        recordingId,
        ownerUserId: null,
        text: segment.text,
        vector: fakeVector(segment.text),
        model: 'fake-embed-1',
      })),
      {
        sourceKind: 'note' as const,
        sourceId: note.id,
        recordingId,
        ownerUserId: null,
        text: note.text ?? '',
        vector: fakeVector(note.text ?? ''),
        model: 'fake-embed-1',
      },
    ],
    handle,
  );
  await setRecordingPublication(recordingId, new Date(), handle);
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

describe('who may search, and with what', () => {
  it('refuses an anonymous caller', async () => {
    const { status } = await get(searchPath({ query: 'anything' }), null);
    expect(status).toBe(401);
  });

  it('refuses an empty query and an unreadable control before anything is spent', async () => {
    const empty = await get<ApiErrorBody>('/search?q=%20', cookie);
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('invalid_input');
    for (const bad of ['kinds=series', 'mix=0.6', 'per=2', 'offset=7']) {
      const refused = await get<ApiErrorBody>(`/search?q=line&${bad}`, cookie);
      expect(refused.status, bad).toBe(400);
      expect(refused.body.error.code).toBe('invalid_input');
    }
  });
});

describe('what comes back (3.10.3, 3.10.6, 3.10.7)', () => {
  it('a segment hit carries its moment, its teaching, its series, its passage in context and how it matched', async () => {
    const { status, body } = await get<SearchPayload>(searchPath({ query: LINE }), cookie);
    expect(status).toBe(200);
    expect(body.query).toBe(LINE);
    expect(body.meaningAvailable).toBe(true);
    expect(body.offset).toBe(0);
    expect(body.showScores).toBe(false);
    const hit = body.hits.find((one) => one.sourceId === segmentId);
    expect(hit).toBeDefined();
    expect(hit?.kind).toBe('segment');
    expect(hit?.startMs).toBe(5_000);
    expect(hit?.recording.id).toBe(recordingId);
    expect(hit?.recording.series?.id).toBe(seriesId);
    expect(hit?.recording.recordedAt).toBe('2026-09-09');
    expect(hit?.passage).toBe(LINE);
    expect(hit?.before).toBe('An opening line.');
    expect(hit?.after).toBeNull();
    expect(hit?.matchedBy).toEqual(['meaning', 'words']);
    // The exact words: a similarity of one, bucketed as a strong match; the words marked.
    expect(hit?.similarity).toBeCloseTo(1, 4);
    expect(meaningLabel(hit?.similarity ?? 0)).toBe(MEANING_LABELS.strong);
    expect(hit?.passageMarked).toContain(`${SEARCH_MARK_START}search${SEARCH_MARK_END}`);
    expect(hit?.passageMarked).toContain(`${SEARCH_MARK_START}route${SEARCH_MARK_END}`);
    expect(hit?.scores).toMatchObject({ vectorRank: 1, textRank: expect.any(Number), similarity: expect.any(Number) });
    expect(hit?.scores.score).toBeGreaterThan(0);
    // The first hit is the line itself: both arms place it first.
    expect(body.hits[0]?.sourceId).toBe(segmentId);
  });

  it('narrows to the kinds asked for', async () => {
    // Words only, so the meaning arm's nearest-whatever-the-distance rows from other suites' notes
    // do not trail in: the one note that says the run's token is the one hit.
    const { body } = await get<SearchPayload>(searchPath({ query: RUN, kinds: ['note'], blend: 0 }), cookie);
    expect(body.hits.map((hit) => hit.sourceId)).toEqual([myNoteId]);
    expect(body.hits[0]?.kind).toBe('note');
    expect(body.hits[0]?.startMs).toBe(5_000);
    // And by meaning too, every row is a note.
    const byMeaning = await get<SearchPayload>(searchPath({ query: RUN, kinds: ['note'] }), cookie);
    expect(byMeaning.body.hits.length).toBeGreaterThan(0);
    expect(byMeaning.body.hits.every((hit) => hit.kind === 'note')).toBe(true);
  });

  it('answers words alone at the "Words only" stop, without calling the provider', async () => {
    const { body } = await get<SearchPayload>(searchPath({ query: RUN, blend: 0 }), cookie);
    expect(body.meaningAvailable).toBe(true);
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.hits.every((hit) => hit.matchedBy.length === 1 && hit.matchedBy[0] === 'words')).toBe(true);
    expect(body.hits.every((hit) => hit.similarity === null && hit.scores.vectorRank === null)).toBe(true);
  });

  it('pages by offset and says whether there is more', async () => {
    const first = await get<SearchPayload>(searchPath({ query: 'line' }), cookie);
    expect(first.body.hits.length).toBeLessThanOrEqual(SEARCH_PAGE_SIZE);
    const second = await get<SearchPayload>(searchPath({ query: 'line', offset: SEARCH_PAGE_SIZE }), cookie);
    expect(second.status).toBe(200);
    expect(second.body.offset).toBe(SEARCH_PAGE_SIZE);
    const firstIds = new Set(first.body.hits.map((hit) => hit.id));
    expect(second.body.hits.some((hit) => firstIds.has(hit.id))).toBe(false);
    if (!first.body.hasMore) expect(second.body.hits).toEqual([]);
  });

  it('discloses the raw scores to an admin and to nobody else', async () => {
    const admin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'search-admin');
    const { body } = await get<SearchPayload>(searchPath({ query: LINE }), admin.cookie);
    expect(body.showScores).toBe(true);
    const asMember = await get<SearchPayload>(searchPath({ query: LINE }), cookie);
    expect(asMember.body.showScores).toBe(false);
    // The numbers ride on every hit either way; the flag decides whether the page draws them.
    expect(asMember.body.hits[0]?.scores).toBeDefined();
  });
});

describe('the cache', () => {
  it('answers the same search again without spending the budget', async () => {
    // A fresh account, so nothing above counts against it: the same address asked more times than
    // the budget allows is answered every time, because only the first one made the call.
    const fresh = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'search-cache');
    const path = searchPath({ query: LINE });
    const first = await get<SearchPayload>(path, fresh.cookie);
    expect(first.status).toBe(200);
    expect(first.body.hits.length).toBeGreaterThan(0);
    for (let again = 0; again <= SEARCH_BUDGET_PER_HOUR; again += 1) {
      const { status, body } = await get<SearchPayload>(path, fresh.cookie);
      expect(status).toBe(200);
      expect(body.hits.map((hit) => hit.id)).toEqual(first.body.hits.map((hit) => hit.id));
    }
    // A different address is a different entry, and is budgeted as the first one was.
    const other = await get<SearchPayload>(searchPath({ query: LINE, blend: 1 }), fresh.cookie);
    expect(other.status).toBe(200);
  }, 120_000);
});

describe('the budget (3.1.22)', () => {
  it(`refuses the search after ${SEARCH_BUDGET_PER_HOUR} in an hour, with a wait`, async () => {
    // A fresh account, so the searches above do not count against it.
    const fresh = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'search-budget');
    let spent = 0;
    for (;;) {
      const { status, body } = await get<ApiErrorBody>(searchPath({ query: `budget ${spent}` }), fresh.cookie);
      if (status === 429) {
        expect(body.error.code).toBe('rate_limited');
        expect(body.error.message).toContain('Try again in');
        break;
      }
      expect(status).toBe(200);
      spent += 1;
      if (spent > SEARCH_BUDGET_PER_HOUR) throw new Error('the budget never refused');
    }
    expect(spent).toBe(SEARCH_BUDGET_PER_HOUR);
  }, 120_000);
});
