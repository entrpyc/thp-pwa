import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  CROSS_REFERENCES_PER_CHAPTER,
  ROLE,
  recordingCrossReferencesPath,
  recordingUnpublishPath,
  type RecordingCrossReferencesPayload,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  insertSeries,
  listChapters,
  listCrossReferencesTouching,
  listSegments,
  replaceChapters,
  replaceCrossReferencesForRun,
  replaceTranscript,
  setRecordingPublication,
  setRecordingSeries,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, signedInAccount } from '../support/accounts';

/**
 * **The member-facing read of a teaching's related moments**
 * ([3.9.2](docs/project/prd.md), [3.9.5](docs/project/prd.md)), over HTTP.
 *
 * The whole of what this file is for is **visibility**: a link reaches a member only when the
 * teaching they are on is published *and* the teaching at the other end is — and the cap the
 * worker applied is applied again to what the member sees. Rows are seeded through `@thp/db`
 * directly, because what is under test is the read in front of the table rather than the step
 * that fills it (that is the worker's suite); the **unpublish press goes through the real route**,
 * because what it does to this table is the route's promise.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const LINE_MS = 10_000;
const LINES = [
  'Good morning to everybody, and a warm welcome to all of you here today.',
  'Turn with me now to the eighth chapter of Romans and read it slowly.',
  'Before we begin, a word about the family we have been praying for this week.',
  'Let us open our hearts and our minds to what we are about to hear together.',
  'A different sentence about something else entirely, said in more than eight words.',
  'And so we come to the end of what there is to say this morning.',
];

let handle: DatabaseHandle;
let adminCookie: string;
let memberCookie: string;
let made = 0;

interface Seeded {
  readonly id: string;
  readonly title: string;
  readonly segmentIds: readonly string[];
}

/** A transcript of six lines, ten seconds apart, chaptered at 0 and 30 s when asked. */
async function teaching(options: {
  published?: boolean;
  chapters?: boolean;
  seriesId?: string | null;
} = {}): Promise<Seeded> {
  made += 1;
  const title = `Cross-referenced ${made} ${Date.now().toString(36)}`;
  const row = await insertRecording(
    { originalMediaKey: `originals/xref-web-${made}-${Date.now().toString(36)}.mp3`, title, recordedAt: '2026-10-02' },
    handle,
  );
  const transcript = await replaceTranscript(
    {
      recordingId: row.id,
      language: 'en',
      confidence: 0.95,
      segments: LINES.map((text, index) => ({ startMs: index * LINE_MS, endMs: (index + 1) * LINE_MS, text })),
    },
    handle,
  );
  if (options.chapters !== false) {
    await replaceChapters(
      row.id,
      [
        { startMs: 0, title: 'First', summary: 'The opening.', editedByAdmin: false },
        { startMs: 3 * LINE_MS, title: 'Second', summary: 'The rest.', editedByAdmin: false },
      ],
      { model: 'fake' },
      handle,
    );
  }
  if (options.seriesId) await setRecordingSeries(row.id, options.seriesId, handle);
  if (options.published !== false) await setRecordingPublication(row.id, new Date(), handle);
  return {
    id: row.id,
    title,
    segmentIds: (await listSegments(transcript.id, handle)).map((one) => one.id),
  };
}

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly body: T;
}

async function call<T>(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Answer<T>> {
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
  const body: unknown = await response.json().catch(() => undefined);
  return {
    status: response.status,
    code:
      typeof body === 'object' && body !== null && 'error' in body
        ? ((body as { error: { code: string } }).error.code ?? null)
        : null,
    body: (typeof body === 'object' && body !== null && 'data' in body
      ? (body as { data: T }).data
      : body) as T,
  };
}

function link(
  from: Seeded,
  fromIndex: number,
  to: Seeded,
  toIndex: number,
  score: number,
): Parameters<typeof replaceCrossReferencesForRun>[1][number] {
  return {
    sourceRecordingId: from.id,
    sourceSegmentId: from.segmentIds[fromIndex] as string,
    targetRecordingId: to.id,
    targetSegmentId: to.segmentIds[toIndex] as string,
    score,
    basis: 'semantic',
  };
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
  adminCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'xref-admin')).cookie;
  memberCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'xref-member')).cookie;
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

describe('GET /recordings/:id/cross-references', () => {
  it('names the other teaching, its series and its moment, grouped by the sentence that triggered it', async () => {
    const study = await insertSeries({ title: `Romans study ${made}`, description: null }, handle);
    const a = await teaching();
    const b = await teaching({ seriesId: study.id });
    await replaceCrossReferencesForRun(a.id, [link(a, 1, b, 4, 0.91)], handle);

    const chapters = await listChapters(a.id, handle);
    const first = chapters.find((one) => one.startMs === 0);

    const answer = await call<RecordingCrossReferencesPayload>(recordingCrossReferencesPath(a.id), {
      cookie: memberCookie,
    });
    expect(answer.status).toBe(200);
    expect(answer.body.groups).toHaveLength(1);
    const group = answer.body.groups[0];
    expect(group).toMatchObject({
      segmentId: a.segmentIds[1],
      startMs: LINE_MS,
      endMs: 2 * LINE_MS,
      text: LINES[1],
      chapterId: first?.id,
    });
    expect(group?.links).toEqual([
      expect.objectContaining({
        recordingId: b.id,
        title: b.title,
        series: expect.objectContaining({ id: study.id, title: study.title, artworkUrl: null }),
        segmentId: b.segmentIds[4],
        startMs: 4 * LINE_MS,
        text: LINES[4],
        basis: 'semantic',
      }),
    ]);
    expect(group?.links[0]?.score).toBeCloseTo(0.91, 4);

    // The mirrored row: B's page reads A back, under A's chapter arithmetic for B's own sentence.
    const mirrored = await call<RecordingCrossReferencesPayload>(recordingCrossReferencesPath(b.id), {
      cookie: memberCookie,
    });
    expect(mirrored.body.groups).toHaveLength(1);
    expect(mirrored.body.groups[0]).toMatchObject({ segmentId: b.segmentIds[4], startMs: 4 * LINE_MS });
    expect(mirrored.body.groups[0]?.links[0]).toMatchObject({ recordingId: a.id, startMs: LINE_MS, series: null });
  });

  it('never shows a link to an unpublished teaching, and never shows an unpublished teaching’s links', async () => {
    const a = await teaching();
    const published = await teaching();
    const draft = await teaching({ published: false });
    await replaceCrossReferencesForRun(
      a.id,
      [link(a, 1, published, 2, 0.8), link(a, 2, draft, 2, 0.99)],
      handle,
    );

    const answer = await call<RecordingCrossReferencesPayload>(recordingCrossReferencesPath(a.id), {
      cookie: memberCookie,
    });
    expect(answer.status).toBe(200);
    expect(answer.body.groups.flatMap((group) => group.links.map((one) => one.recordingId))).toEqual([
      published.id,
    ]);

    // The draft itself: not found for a member, and not found for an admin either — the surface
    // is a member's, and an admin reading it is a member reading it.
    for (const cookie of [memberCookie, adminCookie]) {
      const refused = await call(recordingCrossReferencesPath(draft.id), { cookie });
      expect(refused.status).toBe(404);
      expect(refused.code).toBe('not_found');
    }
    const missing = await call(recordingCrossReferencesPath('00000000-0000-0000-0000-000000000000'), {
      cookie: memberCookie,
    });
    expect(missing.status).toBe(404);

    const anonymous = await call(recordingCrossReferencesPath(a.id));
    expect(anonymous.status).toBe(401);
    expect(anonymous.code).toBe('unauthenticated');
  });

  it('shows at most three per chapter, one per other teaching, the strongest of both runs’ opinions', async () => {
    const a = await teaching();
    const others = await Promise.all([teaching(), teaching(), teaching(), teaching()]);
    const [b, c, d, e] = others as [Seeded, Seeded, Seeded, Seeded];

    // A's own run chose B and C for the first chapter; the other teachings' runs added their links
    // back to A, which is how a chapter comes to hold more than three (3.9.6). The same pair from
    // two runs — A→B at 0.9 by A's run, 0.95 by B's — is one link under the higher score.
    await replaceCrossReferencesForRun(a.id, [link(a, 0, b, 0, 0.9), link(a, 1, c, 0, 0.85)], handle);
    await replaceCrossReferencesForRun(b.id, [link(b, 0, a, 0, 0.95)], handle);
    await replaceCrossReferencesForRun(d.id, [link(d, 0, a, 2, 0.8)], handle);
    await replaceCrossReferencesForRun(e.id, [link(e, 0, a, 2, 0.75), link(e, 1, a, 4, 0.7)], handle);

    const answer = await call<RecordingCrossReferencesPayload>(recordingCrossReferencesPath(a.id), {
      cookie: memberCookie,
    });
    expect(answer.status).toBe(200);
    const chapters = await listChapters(a.id, handle);
    const [first, second] = [...chapters].sort((x, y) => x.startMs - y.startMs);

    const inFirst = answer.body.groups.filter((group) => group.chapterId === first?.id);
    const inSecond = answer.body.groups.filter((group) => group.chapterId === second?.id);
    expect(inFirst.flatMap((group) => group.links).length).toBe(CROSS_REFERENCES_PER_CHAPTER);
    expect(inFirst.map((group) => [group.startMs, group.links.map((one) => one.recordingId)])).toEqual([
      [0, [b.id]],
      [LINE_MS, [c.id]],
      [2 * LINE_MS, [d.id]],
    ]);
    expect(inFirst[0]?.links[0]?.score).toBeCloseTo(0.95, 4);
    // E lost the first chapter to the cap and keeps its place in the second.
    expect(inSecond.map((group) => [group.startMs, group.links.map((one) => one.recordingId)])).toEqual([
      [4 * LINE_MS, [e.id]],
    ]);
    // Groups come back in the order they are spoken, whatever their scores.
    expect(answer.body.groups.map((group) => group.startMs)).toEqual([0, LINE_MS, 2 * LINE_MS, 4 * LINE_MS]);
  });

  it('a teaching with no chapters is one chapter, and unpublishing takes its links away on both ends', async () => {
    const a = await teaching({ chapters: false });
    const b = await teaching();
    await replaceCrossReferencesForRun(a.id, [link(a, 1, b, 1, 0.9), link(a, 4, b, 2, 0.8)], handle);

    const before = await call<RecordingCrossReferencesPayload>(recordingCrossReferencesPath(a.id), {
      cookie: memberCookie,
    });
    // One bucket, one other teaching: the strongest of the two is the one shown.
    expect(before.body.groups.map((group) => [group.chapterId, group.startMs])).toEqual([[null, LINE_MS]]);

    const taken = await call(recordingUnpublishPath(b.id), { method: 'POST', cookie: adminCookie });
    expect(taken.status).toBe(200);
    expect(await listCrossReferencesTouching(b.id, handle)).toEqual([]);

    const after = await call<RecordingCrossReferencesPayload>(recordingCrossReferencesPath(a.id), {
      cookie: memberCookie,
    });
    expect(after.status).toBe(200);
    expect(after.body.groups).toEqual([]);
  });
});
