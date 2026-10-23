import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  ROLE,
  SEARCH_BUDGET_PER_HOUR,
  SEARCH_FILTERS_PATH,
  searchPath,
  type ApiErrorBody,
  type SearchFiltersPayload,
  type SearchPayload,
} from '@thp/shared';
import {
  createDatabase,
  ensureTags,
  insertNote,
  insertRecording,
  insertSeries,
  listSegments,
  replaceRecordingTags,
  replaceScriptureReferences,
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
 * The query's own properties — visibility inside the top-k, every filter, the fusion order — are
 * proved in `packages/db/tests/integration/search.test.ts`. What this file pins is the layer on
 * top: who may call, what a bad address is refused with, that the member's own notes come back
 * under `mine`, that a chapter hit and a segment hit carry what the page needs to go somewhere,
 * and that the sixty-first search in an hour is refused with a wait.
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
let tagId: string;
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
  const [tag] = await ensureTags([`search-tag-${RUN}`], handle);
  tagId = tag?.id ?? '';
  await replaceRecordingTags(recordingId, [tagId], handle);
  await replaceScriptureReferences(
    recordingId,
    [{ book: 'john', chapter: 15, verseStart: 1, verseEnd: 8, origin: 'machine', editedByAdmin: false, anchorMs: 0 }],
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

  it('refuses an empty query and an unreadable filter before anything is spent', async () => {
    const empty = await get<ApiErrorBody>('/search?q=%20', cookie);
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('invalid_input');
    const badSeries = await get<ApiErrorBody>('/search?q=line&series=not-a-uuid', cookie);
    expect(badSeries.status).toBe(400);
    const badBook = await get<ApiErrorBody>('/search?q=line&book=hezekiah', cookie);
    expect(badBook.status).toBe(400);
  });
});

describe('what comes back (3.10.3, 3.10.6, 3.10.7)', () => {
  it('a segment hit carries its moment, its teaching, its series and its passage in context', async () => {
    const { status, body } = await get<SearchPayload>(searchPath({ query: LINE }), cookie);
    expect(status).toBe(200);
    expect(body.query).toBe(LINE);
    expect(body.meaningAvailable).toBe(true);
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
    // The first hit is the line itself: both arms place it first.
    expect(body.hits[0]?.sourceId).toBe(segmentId);
  });

  it('every filter is read off the address and narrows', async () => {
    const on = await get<SearchPayload>(
      searchPath({ query: LINE, seriesId, tagId, book: 'john', recordedFrom: '2026-09-09', recordedTo: '2026-09-09' }),
      cookie,
    );
    expect(on.status).toBe(200);
    expect(on.body.hits.map((hit) => hit.sourceId)).toContain(segmentId);
    const off = await get<SearchPayload>(searchPath({ query: LINE, book: 'romans' }), cookie);
    expect(off.body.hits).toEqual([]);
  });

  it('`mine` answers the member’s own notes and nothing else (3.10.10)', async () => {
    const { body } = await get<SearchPayload>(searchPath({ query: RUN, onlyMine: true }), cookie);
    expect(body.hits.map((hit) => hit.sourceId)).toEqual([myNoteId]);
    expect(body.hits[0]?.kind).toBe('note');
    expect(body.hits[0]?.startMs).toBe(5_000);
  });

  it('the filters route offers exactly what the published library carries (3.10.8)', async () => {
    const { status, body } = await get<SearchFiltersPayload>(SEARCH_FILTERS_PATH, cookie);
    expect(status).toBe(200);
    expect(body.series.map((one) => one.id)).toContain(seriesId);
    expect(body.tags.map((one) => one.id)).toContain(tagId);
    expect(body.books.map((one) => one.id)).toContain('john');
    expect(body.books.find((one) => one.id === 'john')?.name).toBe('John');
  });
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
