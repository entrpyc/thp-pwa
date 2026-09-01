import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  ROLE,
  chapterMergePath,
  chapterPath,
  chapterSplitPath,
  recordingChaptersPath,
  recordingNotesPath,
  recordingScripturePath,
  recordingTranscriptPath,
  scopedToChapter,
  type ChaptersPayload,
  type NotesPayload,
  type RecordingScripturePayload,
  type TranscriptPayload,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  listChapters,
  replaceChapters,
  replaceScriptureReferences,
  replaceTranscript,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, signedInAccount } from '../support/accounts';

/**
 * **The chapter routes**, over HTTP ([3.22](docs/project/prd.md)).
 *
 * Three things this file is for, and it is deliberately not for a fourth.
 *
 * 1. **The gate is the recording's, and only the recording's**
 *    ([3.22.6](docs/project/prd.md)). Chapters carry no publication state of their own, so every
 *    way a member can fail to see a teaching is a way they fail to see its chapters — and there is
 *    no fourth way that applies to chapters alone.
 * 2. **What the API derives** ([4.19](docs/project/prd.md)): the position a list shows and the end
 *    of each chapter. Neither is stored, so neither is a fact about a row that a database test
 *    could pin — they are facts about the answer.
 * 3. **The rules an edit has to satisfy** ([3.22.2](docs/project/prd.md),
 *    [3.22.5](docs/project/prd.md), [3.22.7](docs/project/prd.md)). Each is asserted as a refusal
 *    with a reason, because a rule the API only *usually* enforces is a rule the form is enforcing.
 *
 * The **scoped reads** ([3.22.14](docs/project/prd.md)) are here too, and they are the reason
 * [3.7.10](docs/project/prd.md) had to land first: a citation with no offset cannot be scoped to
 * anything, and this is where that is checked to be true rather than assumed.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const MINUTE = 60_000;
const LINE_MS = 10_000;

const GENERATED = { model: 'fake', modelVersion: 'fake-1', promptVersion: 'chapters-1' };

/** A three-chapter tiling of a sixty-minute teaching, on transcript-line boundaries. */
const THREE = [
  { startMs: 0, title: 'The vine', summary: 'Abiding in the vine.' },
  { startMs: 20 * MINUTE, title: 'The branches', summary: 'What bearing fruit costs.' },
  { startMs: 40 * MINUTE, title: 'The gardener', summary: 'Why pruning is kindness.' },
];

let handle: DatabaseHandle;
let adminCookie: string;
let memberCookie: string;
let seeded = 0;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly message: string | null;
  readonly body: T;
}

async function call<T>(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<Answer<T>> {
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
  const error = (body as { error?: { code?: string; message?: string } })?.error;
  return {
    status: response.status,
    code: error?.code ?? null,
    message: error?.message ?? null,
    body: body as T,
  };
}

/** A published, transcribed teaching with `chapters` on it. */
async function teaching(
  options: {
    chapters?: readonly { startMs: number; title: string; summary: string }[];
    published?: boolean;
    minutes?: number;
  } = {},
): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    {
      originalMediaKey: `originals/chapter-api-${seeded}-${Date.now().toString(36)}.mp3`,
      title: `Chapter API ${seeded} ${Date.now().toString(36)}`,
      recordedAt: '2026-08-16',
    },
    handle,
  );

  const lines = Math.round(((options.minutes ?? 60) * MINUTE) / LINE_MS);
  await replaceTranscript(
    {
      recordingId: row.id,
      language: 'en',
      confidence: 0.95,
      segments: Array.from({ length: lines }, (_unused, index) => ({
        startMs: index * LINE_MS,
        endMs: (index + 1) * LINE_MS,
        text: `Line ${index + 1} of the teaching.`,
      })),
    },
    handle,
  );

  await replaceChapters(row.id, options.chapters ?? THREE, GENERATED, handle);
  if (options.published !== false) await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

const readChapters = (recordingId: string, cookie: string | null = memberCookie) =>
  call<ChaptersPayload>(
    recordingChaptersPath(recordingId),
    cookie === null ? {} : { cookie },
  );

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 6 });
  adminCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'chapter-api-admin')).cookie;
  memberCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'chapter-api-member'))
    .cookie;
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

describe('reading a teaching’s chapters (3.22.6, 3.22.10)', () => {
  it('answers a member the list, in order', async () => {
    const recordingId = await teaching();
    const answer = await readChapters(recordingId);

    expect(answer.status).toBe(200);
    expect(answer.body.chapters.map((one) => one.title)).toEqual([
      'The vine',
      'The branches',
      'The gardener',
    ]);
  });

  /**
   * **The gate is the recording's** ([3.22.6](docs/project/prd.md)). An unpublished teaching and one
   * that never existed answer the same `not_found`, so the API does not report which ids exist.
   */
  it('refuses an unpublished teaching’s chapters, exactly as it refuses a teaching that is not there', async () => {
    const unpublished = await teaching({ published: false });
    const draft = await readChapters(unpublished);
    const missing = await readChapters('00000000-0000-4000-8000-000000000000');

    expect(draft.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(draft.code).toBe(missing.code);
  });

  /** An admin reads them under the same gate — there is no console shape for a chapter. */
  it('refuses an unpublished teaching’s chapters to an admin too', async () => {
    const unpublished = await teaching({ published: false });
    expect((await readChapters(unpublished, adminCookie)).status).toBe(404);
  });

  it('refuses an anonymous caller, like every other route', async () => {
    const recordingId = await teaching();
    expect((await readChapters(recordingId, null)).status).toBe(401);
  });

  /** 3.22.4 — a teaching too short to hold two has none, and that is an answer rather than a failure. */
  it('answers an empty list for a teaching with no chapters', async () => {
    const recordingId = await teaching({ chapters: [] });
    const answer = await readChapters(recordingId);

    expect(answer.status).toBe(200);
    expect(answer.body.chapters).toEqual([]);
  });
});

describe('what the API derives (4.19)', () => {
  /**
   * **Position is the order, one-based** — derived from `start_ms` ascending rather than stored, so
   * a split renumbers nothing.
   */
  it('numbers the chapters by their order', async () => {
    const recordingId = await teaching();
    const { chapters } = (await readChapters(recordingId)).body;

    expect(chapters.map((one) => one.position)).toEqual([1, 2, 3]);
  });

  /**
   * **A chapter ends where the next one begins, and the last ends where the transcript does** — so
   * the list tiles the teaching exactly ([3.22.2](docs/project/prd.md),
   * [4.2](docs/project/prd.md)).
   */
  it('ends each chapter where the next begins, and the last at the end of the transcript', async () => {
    const recordingId = await teaching({ minutes: 60 });
    const { chapters } = (await readChapters(recordingId)).body;

    expect(chapters.map((one) => one.endMs)).toEqual([20 * MINUTE, 40 * MINUTE, 60 * MINUTE]);
    for (let index = 1; index < chapters.length; index += 1) {
      // No gaps and no overlaps, said as an equality rather than as two inequalities.
      expect(chapters[index]!.startMs).toBe(chapters[index - 1]!.endMs);
    }
  });
});

describe('editing a chapter (3.22.7)', () => {
  it('retitles and rewrites, and answers with the whole list', async () => {
    const recordingId = await teaching();
    const [, second] = await listChapters(recordingId, handle);

    const answer = await call<ChaptersPayload>(chapterPath(second!.id), {
      method: 'PUT',
      cookie: adminCookie,
      body: JSON.stringify({
        title: 'The branches, renamed',
        summary: 'Rewritten by an admin.',
        startMs: second!.startMs,
      }),
    });

    expect(answer.status).toBe(200);
    // The whole list, because a boundary move changes where the chapter before it ends — a payload
    // carrying one row would be a payload that is wrong about two of them.
    expect(answer.body.chapters).toHaveLength(3);
    expect(answer.body.chapters[1]?.title).toBe('The branches, renamed');
    expect(answer.body.chapters[1]?.editedByAdmin).toBe(true);
  });

  /**
   * **Moving a boundary ends one chapter and starts the next, in a single action**
   * ([3.22.7](docs/project/prd.md)) — which is visible in the answer as two chapters changing from
   * one write.
   */
  it('ends the chapter before it and starts this one, from one write', async () => {
    const recordingId = await teaching();
    const [, second] = await listChapters(recordingId, handle);

    const answer = await call<ChaptersPayload>(chapterPath(second!.id), {
      method: 'PUT',
      cookie: adminCookie,
      body: JSON.stringify({
        title: second!.title,
        summary: second!.summary,
        startMs: 30 * MINUTE,
      }),
    });

    expect(answer.body.chapters[0]?.endMs).toBe(30 * MINUTE);
    expect(answer.body.chapters[1]?.startMs).toBe(30 * MINUTE);
  });

  /** 3.22.5 — no chapter opens half a sentence in, and the API is what says so. */
  it('refuses a boundary that is not the start of a transcript line', async () => {
    const recordingId = await teaching();
    const [, second] = await listChapters(recordingId, handle);

    const answer = await call(chapterPath(second!.id), {
      method: 'PUT',
      cookie: adminCookie,
      body: JSON.stringify({ title: second!.title, summary: second!.summary, startMs: 25 * MINUTE + 1 }),
    });

    expect(answer.status).toBe(400);
    expect(answer.message).toContain('line of the transcript');
  });

  /** A move that crossed a neighbour would reorder the list, which is not an edit anybody asked for. */
  it('refuses a boundary that would cross the chapter before or after it', async () => {
    const recordingId = await teaching();
    const [, second] = await listChapters(recordingId, handle);

    const tooEarly = await call(chapterPath(second!.id), {
      method: 'PUT',
      cookie: adminCookie,
      body: JSON.stringify({ title: second!.title, summary: second!.summary, startMs: 0 }),
    });
    const tooLate = await call(chapterPath(second!.id), {
      method: 'PUT',
      cookie: adminCookie,
      body: JSON.stringify({ title: second!.title, summary: second!.summary, startMs: 50 * MINUTE }),
    });

    expect(tooEarly.status).toBe(400);
    expect(tooEarly.message).toContain('after the start of the chapter before it');
    expect(tooLate.status).toBe(400);
    expect(tooLate.message).toContain('before the start of the chapter after it');
  });

  /**
   * **The first chapter keeps the first boundary.** Moving it would put the opening of the teaching
   * in no chapter at all — the one hole the no-end design cannot rule out on its own.
   */
  it('refuses to move the first chapter’s boundary', async () => {
    const recordingId = await teaching();
    const [first] = await listChapters(recordingId, handle);

    const answer = await call(chapterPath(first!.id), {
      method: 'PUT',
      cookie: adminCookie,
      body: JSON.stringify({ title: first!.title, summary: first!.summary, startMs: 10 * MINUTE }),
    });

    expect(answer.status).toBe(400);
    expect(answer.message).toContain('cannot be moved');
  });

  it('refuses a blank title or a blank summary (4.19)', async () => {
    const recordingId = await teaching();
    const [, second] = await listChapters(recordingId, handle);

    const noTitle = await call(chapterPath(second!.id), {
      method: 'PUT',
      cookie: adminCookie,
      body: JSON.stringify({ title: '   ', summary: 'Something.', startMs: second!.startMs }),
    });
    const noSummary = await call(chapterPath(second!.id), {
      method: 'PUT',
      cookie: adminCookie,
      body: JSON.stringify({ title: 'Something.', summary: '', startMs: second!.startMs }),
    });

    expect(noTitle.status).toBe(400);
    expect(noSummary.status).toBe(400);
  });

  /** The client holds no decision: the API is what refuses ([3.1.5](docs/project/prd.md)). */
  it('refuses a member, whatever their screen offered them', async () => {
    const recordingId = await teaching();
    const [, second] = await listChapters(recordingId, handle);

    const answer = await call(chapterPath(second!.id), {
      method: 'PUT',
      cookie: memberCookie,
      body: JSON.stringify({ title: 'Mine now', summary: 'Mine.', startMs: second!.startMs }),
    });

    expect(answer.status).toBe(403);
    // And nothing was written.
    expect((await listChapters(recordingId, handle))[1]?.title).toBe('The branches');
  });
});

describe('splitting a chapter (3.22.7)', () => {
  it('cuts one in two, leaving the tiling exact', async () => {
    const recordingId = await teaching();
    const [first] = await listChapters(recordingId, handle);

    const answer = await call<ChaptersPayload>(chapterSplitPath(first!.id), {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({
        startMs: 10 * MINUTE,
        title: 'The second half of the first',
        summary: 'Cut out by an admin.',
      }),
    });

    expect(answer.status).toBe(200);
    expect(answer.body.chapters.map((one) => one.startMs)).toEqual([
      0,
      10 * MINUTE,
      20 * MINUTE,
      40 * MINUTE,
    ]);
    // The chapter being split keeps its own title and simply ends earlier.
    expect(answer.body.chapters[0]?.title).toBe('The vine');
    expect(answer.body.chapters[0]?.endMs).toBe(10 * MINUTE);
    // And the numbers a list shows follow the new order, without anything renumbering a row.
    expect(answer.body.chapters.map((one) => one.position)).toEqual([1, 2, 3, 4]);
  });

  it('refuses a cut on the chapter’s own start, or past its end', async () => {
    const recordingId = await teaching();
    const [first] = await listChapters(recordingId, handle);

    const atStart = await call(chapterSplitPath(first!.id), {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ startMs: 0, title: 'Nothing cut', summary: 'Nothing.' }),
    });
    const pastEnd = await call(chapterSplitPath(first!.id), {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ startMs: 30 * MINUTE, title: 'Elsewhere', summary: 'Elsewhere.' }),
    });

    expect(atStart.status).toBe(400);
    expect(pastEnd.status).toBe(400);
  });

  it('refuses a cut that is not on a transcript line (3.22.5)', async () => {
    const recordingId = await teaching();
    const [first] = await listChapters(recordingId, handle);

    const answer = await call(chapterSplitPath(first!.id), {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ startMs: 10 * MINUTE + 1, title: 'Halfway in', summary: 'Half.' }),
    });

    expect(answer.status).toBe(400);
    expect(answer.message).toContain('line of the transcript');
  });
});

describe('merging a chapter (3.22.7, 3.22.4)', () => {
  it('removes this chapter’s boundary, so the one before it runs on', async () => {
    const recordingId = await teaching();
    const [, second] = await listChapters(recordingId, handle);

    const answer = await call<ChaptersPayload>(chapterMergePath(second!.id), {
      method: 'POST',
      cookie: adminCookie,
    });

    expect(answer.status).toBe(200);
    expect(answer.body.chapters.map((one) => one.title)).toEqual(['The vine', 'The gardener']);
    // The survivor runs on to where the merged one used to end, and it was not written to.
    expect(answer.body.chapters[0]?.endMs).toBe(40 * MINUTE);
    expect(answer.body.chapters[0]?.editedByAdmin).toBe(false);
  });

  /**
   * **The first chapter has no boundary of its own to remove** — its start is the start of the
   * teaching, so the request names no pair.
   */
  it('refuses to merge the first chapter, because there is nothing before it', async () => {
    const recordingId = await teaching();
    const [first] = await listChapters(recordingId, handle);

    const answer = await call(chapterMergePath(first!.id), { method: 'POST', cookie: adminCookie });

    expect(answer.status).toBe(400);
    expect(answer.message).toContain('nothing before it to merge into');
  });

  /**
   * **Two chapters merged is one chapter, which 3.22.4 refuses** — "every surface leaves them out
   * rather than offering a single row that is the whole teaching". So the survivor goes as well.
   */
  it('empties the list when a merge would leave one chapter', async () => {
    const recordingId = await teaching({
      chapters: [
        { startMs: 0, title: 'One half', summary: 'The first.' },
        { startMs: 30 * MINUTE, title: 'The other', summary: 'The second.' },
      ],
    });
    const [, second] = await listChapters(recordingId, handle);

    const answer = await call<ChaptersPayload>(chapterMergePath(second!.id), {
      method: 'POST',
      cookie: adminCookie,
    });

    expect(answer.body.chapters).toEqual([]);
    expect(await listChapters(recordingId, handle)).toEqual([]);
  });
});

/**
 * **Scoping a read to one chapter** ([3.22.14](docs/project/prd.md); project tdd 5.9).
 *
 * A note belongs to the chapter its timestamp falls in, a citation to the chapter its anchor falls
 * in, and the transcript stops at the boundaries. Every one of the three is the same half-open
 * interval, and the scope travels as a **chapter id** rather than as a pair of offsets — so a client
 * cannot ask for a stretch of teaching that is not a chapter.
 */
describe('scoping a read to one chapter (3.22.14)', () => {
  /** A teaching with one citation in the first chapter, one in the third, and one unplaced. */
  async function withReferences(): Promise<string> {
    const recordingId = await teaching();
    await replaceScriptureReferences(
      recordingId,
      [
        {
          book: 'john',
          chapter: 15,
          verseStart: 1,
          verseEnd: 2,
          origin: 'machine',
          editedByAdmin: false,
          anchorMs: 5 * MINUTE,
        },
        {
          book: 'romans',
          chapter: 8,
          verseStart: 1,
          verseEnd: 4,
          origin: 'machine',
          editedByAdmin: false,
          anchorMs: 45 * MINUTE,
        },
        {
          book: 'psalm',
          chapter: 23,
          verseStart: 1,
          verseEnd: 6,
          // 3.7.10 — one an admin added by hand carries no position, so it belongs to the recording
          // rather than to any chapter.
          origin: 'person',
          editedByAdmin: false,
          anchorMs: null,
        },
      ],
      handle,
    );
    return recordingId;
  }

  it('answers only the citations anchored inside the chapter, and none of the unplaced ones', async () => {
    const recordingId = await withReferences();
    const { chapters } = (await readChapters(recordingId)).body;

    const first = await call<RecordingScripturePayload>(
      scopedToChapter(recordingScripturePath(recordingId), chapters[0]!.id),
      { cookie: memberCookie },
    );
    const third = await call<RecordingScripturePayload>(
      scopedToChapter(recordingScripturePath(recordingId), chapters[2]!.id),
      { cookie: memberCookie },
    );

    expect(first.body.references.map((one) => one.book)).toEqual(['john']);
    expect(third.body.references.map((one) => one.book)).toEqual(['romans']);
  });

  /**
   * **Nothing appears under two chapters, and the teaching's own list is the whole of it** — the
   * unplaced citation is in no chapter's answer and in the recording's, which is exactly where
   * 3.7.10 puts it.
   */
  it('reads every reference on the teaching, placed or not', async () => {
    const recordingId = await withReferences();
    const whole = await call<RecordingScripturePayload>(recordingScripturePath(recordingId), {
      cookie: memberCookie,
    });
    const { chapters } = (await readChapters(recordingId)).body;

    expect(whole.body.references).toHaveLength(3);
    const scoped = await Promise.all(
      chapters.map(async (chapter) =>
        (
          await call<RecordingScripturePayload>(
            scopedToChapter(recordingScripturePath(recordingId), chapter.id),
            { cookie: memberCookie },
          )
        ).body.references,
      ),
    );
    // Two of the three are in exactly one chapter each; the unplaced one is in none.
    expect(scoped.flat()).toHaveLength(2);
    expect(new Set(scoped.flat().map((one) => one.book)).size).toBe(2);
  });

  it('carries the anchor to the reader, so a surface can tell a placed citation from one that is not', async () => {
    const recordingId = await withReferences();
    const whole = await call<RecordingScripturePayload>(recordingScripturePath(recordingId), {
      cookie: memberCookie,
    });

    const anchors = new Map(whole.body.references.map((one) => [one.book, one.anchorMs]));
    expect(anchors.get('john')).toBe(5 * MINUTE);
    expect(anchors.get('psalm')).toBeNull();
  });

  it('stops the transcript at the chapter’s boundaries', async () => {
    const recordingId = await teaching();
    const { chapters } = (await readChapters(recordingId)).body;
    const second = chapters[1]!;

    const scoped = await call<TranscriptPayload>(
      scopedToChapter(recordingTranscriptPath(recordingId), second.id),
      { cookie: memberCookie },
    );

    const segments = scoped.body.transcript?.segments ?? [];
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[0]?.startMs).toBe(second.startMs);
    expect(segments.every((one) => one.startMs >= second.startMs)).toBe(true);
    expect(segments.every((one) => one.startMs < second.endMs)).toBe(true);
  });

  /** Every line of the teaching is in exactly one chapter, which is 3.22.2 doing its work. */
  it('puts every transcript line in exactly one chapter', async () => {
    const recordingId = await teaching();
    const { chapters } = (await readChapters(recordingId)).body;

    const whole = await call<TranscriptPayload>(recordingTranscriptPath(recordingId), {
      cookie: memberCookie,
    });
    const scoped = await Promise.all(
      chapters.map(async (chapter) =>
        (
          await call<TranscriptPayload>(
            scopedToChapter(recordingTranscriptPath(recordingId), chapter.id),
            { cookie: memberCookie },
          )
        ).body.transcript?.segments ?? [],
      ),
    );

    const ids = scoped.flat().map((one) => one.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(whole.body.transcript?.segments.length ?? -1);
  });

  it('answers a chapter’s notes by where they sit', async () => {
    const recordingId = await teaching();
    const { chapters } = (await readChapters(recordingId)).body;

    for (const [at, text] of [
      [MINUTE, 'A note in the first chapter'],
      [25 * MINUTE, 'A note in the second'],
    ] as const) {
      const written = await call(recordingNotesPath(recordingId), {
        method: 'POST',
        cookie: memberCookie,
        body: JSON.stringify({ text, visibility: 'private', timestampMs: at }),
      });
      expect(written.status).toBe(200);
    }

    const first = await call<NotesPayload>(
      scopedToChapter(recordingNotesPath(recordingId), chapters[0]!.id),
      { cookie: memberCookie },
    );
    const second = await call<NotesPayload>(
      scopedToChapter(recordingNotesPath(recordingId), chapters[1]!.id),
      { cookie: memberCookie },
    );

    expect(first.body.notes.map((one) => one.text)).toEqual(['A note in the first chapter']);
    expect(second.body.notes.map((one) => one.text)).toEqual(['A note in the second']);
  });

  /**
   * A scope that names no chapter of this teaching is **refused rather than widened**. A member
   * whose scope silently widened would be shown the whole teaching's notes under one chapter's
   * heading.
   */
  it('refuses a chapter id that belongs to another teaching, rather than answering unscoped', async () => {
    const one = await teaching();
    const other = await teaching();
    const elsewhere = (await readChapters(other)).body.chapters[0]!;

    const answer = await call(scopedToChapter(recordingNotesPath(one), elsewhere.id), {
      cookie: memberCookie,
    });

    expect(answer.status).toBe(404);
  });

  /** `?chapter=` built from an empty variable is a caller's bug, not a member's error. */
  it('reads a blank scope as no scope at all', async () => {
    const recordingId = await teaching();
    const answer = await call<NotesPayload>(`${recordingNotesPath(recordingId)}?chapter=`, {
      cookie: memberCookie,
    });
    expect(answer.status).toBe(200);
  });
});
