import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  FLOW_SESSIONS_PATH,
  FLOW_TEACHINGS_PATH,
  ROLE,
  chapterQuestionPath,
  flowSessionAbandonPath,
  flowSessionItemDonePath,
  flowSessionItemPath,
  flowSessionPath,
  isApiErrorBody,
  recordingChaptersPath,
  tagQuestionPath,
  tagQuestionsPath,
  type ChapterQuestionPayload,
  type ChaptersPayload,
  type FlowRating,
  type FlowSessionPayload,
  type FlowSessionView,
  type FlowSessionsPayload,
  type FlowTeachingsPayload,
  type TagQuestionsPayload,
} from '@thp/shared';
import {
  createDatabase,
  deleteChapter,
  insertGeneratedQuestions,
  insertRecording,
  insertSeries,
  insertTag,
  insertTagQuestion,
  listSegments,
  replaceChapters,
  replaceCrossReferencesForRun,
  replaceRecordingTags,
  replaceTranscript,
  setRecordingPublication,
  setRecordingSeries,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, signIn, type TestAccount } from '../support/accounts';

/**
 * **The Flow Tracker over the API** ([3.14](docs/project/prd.md)) — driven through the routes a
 * client would use.
 *
 * Seven claims:
 *
 * 1. **The start screen's list** is every published teaching, newest first, with how many
 *    questions each contributes and which tags it carries ([3.14.2](docs/project/prd.md)).
 * 2. **A session is assembled over the picked teachings, in the asking order**
 *    ([3.14.2](docs/project/prd.md), [3.14.3](docs/project/prd.md), [3.14.5](docs/project/prd.md)):
 *    only what was picked, newest teaching first, last chapter first within it, a chapterless
 *    teaching once, and each tag's bank once at the end. One session in progress at a time
 *    ([3.14.10](docs/project/prd.md)).
 * 3. **Answering** takes a rating from 1 to 5, replaces on a second press, and the last answer
 *    completes the session ([3.14.6](docs/project/prd.md)).
 * 4. **The reading list** holds the gaps only — 3 and below — grouped by teaching oldest first,
 *    each row with the chapter to open and the related chapters of other teachings beneath it; a
 *    row can be ticked ([3.14.6](docs/project/prd.md), [3.14.7](docs/project/prd.md),
 *    [3.14.9](docs/project/prd.md)).
 * 5. **Snapshots hold** ([3.14.10](docs/project/prd.md)): a chapter deleted after asking keeps an
 *    answered item and drops an unanswered one.
 * 6. **It is the member's own** ([3.14.8](docs/project/prd.md)): another member finds nothing, no
 *    session is `401`.
 * 7. **Admins curate** ([3.14.11](docs/project/prd.md)): a chapter's question is rewritten in place
 *    and rides the chapter list; a tag's bank is added to and removed from; a member is refused.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const MADE_UP_ID = '00000000-0000-4000-8000-000000000000';
const MINUTE = 60_000;
const GENERATED = { model: 'fake', modelVersion: 'fake-1', promptVersion: 'reflections-1' };
const CHAPTERS_BY = { model: 'fake', modelVersion: 'fake-1', promptVersion: 'chapters-1' };

let handle: DatabaseHandle;

interface Signed extends TestAccount {
  readonly cookie: string;
}

let alice: Signed;
let bob: Signed;
let admin: Signed;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly message: string;
  readonly body: T;
}

async function call<T>(
  path: string,
  init: { method?: string; cookie?: string; body?: unknown },
): Promise<Answer<T>> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body = (await response.json().catch(() => undefined)) as unknown;
  return {
    status: response.status,
    code: isApiErrorBody(body) ? body.error.code : null,
    message: isApiErrorBody(body) ? body.error.message : '',
    body: body as T,
  };
}

async function signedIn(role: 'admin' | 'member', label: string): Promise<Signed> {
  const account = await createAccount(databaseUrl, ROLE[role], `${label}-${RUN}`);
  const result = await signIn(baseUrl, account.email, account.password);
  if (result.cookie === null) throw new Error(`no cookie for ${account.email}`);
  return { ...account, cookie: result.cookie };
}

interface Teaching {
  readonly id: string;
  readonly chapterIds: readonly string[];
  readonly segmentIds: readonly string[];
}

/**
 * A published teaching recorded on `recordedAt`, with a six-line transcript and `chapters`
 * chapters, each with a generated question. Dated in the 2090s so these are the newest teachings
 * in the shared suite database.
 */
async function teaching(title: string, recordedAt: string, chapters = 3, published = true): Promise<Teaching> {
  const row = await insertRecording(
    { originalMediaKey: `originals/flow-${title.replace(/\W+/g, '-')}-${RUN}.mp3`, title, recordedAt },
    handle,
  );
  const transcript = await replaceTranscript(
    {
      recordingId: row.id,
      language: 'en',
      confidence: 0.95,
      segments: Array.from({ length: 6 }, (_unused, index) => ({
        startMs: index * 10 * MINUTE,
        endMs: (index + 1) * 10 * MINUTE,
        text: `Line ${index + 1} of ${title}.`,
      })),
    },
    handle,
  );
  const written = await replaceChapters(
    row.id,
    Array.from({ length: chapters }, (_unused, index) => ({
      startMs: index * 20 * MINUTE,
      title: `${title} ch${index + 1}`,
      summary: `Summary of ${title} ch${index + 1}.`,
    })),
    CHAPTERS_BY,
    handle,
  );
  if (chapters > 0) {
    await insertGeneratedQuestions(
      written.map((one) => ({ scope: 'chapter' as const, chapterId: one.id, text: `Q about ${one.title}?`, generatedBy: GENERATED })),
      handle,
    );
  } else {
    await insertGeneratedQuestions(
      [{ scope: 'recording', recordingId: row.id, text: `Q about ${title} as a whole?`, generatedBy: GENERATED }],
      handle,
    );
  }
  if (published) await setRecordingPublication(row.id, new Date(), handle);
  return {
    id: row.id,
    chapterIds: written.map((one) => one.id),
    segmentIds: (await listSegments(transcript.id, handle)).map((one) => one.id),
  };
}

async function start(who: Signed, recordingIds: unknown) {
  return call<FlowSessionPayload>(FLOW_SESSIONS_PATH, { method: 'POST', cookie: who.cookie, body: { recordingIds } });
}

async function started(who: Signed, recordingIds: readonly string[]): Promise<FlowSessionView> {
  const answer = await start(who, recordingIds);
  if (answer.status !== 201) throw new Error(`start refused ${answer.status}: ${answer.message}`);
  return answer.body.session;
}

async function answer(who: Signed, session: string, item: string, rating: FlowRating | unknown) {
  return call<FlowSessionPayload>(flowSessionItemPath(session, item), { method: 'PUT', cookie: who.cookie, body: { rating } });
}

async function abandon(who: Signed, session: string) {
  return call<FlowSessionPayload>(flowSessionAbandonPath(session), { method: 'POST', cookie: who.cookie });
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 6 });
  alice = await signedIn('member', 'flow-alice');
  bob = await signedIn('member', 'flow-bob');
  admin = await signedIn('admin', 'flow-admin');
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

/** Each test's teachings sit in their own year, so one test's pick is never confused with another's. */
let year = 2090;
function nextYear(): number {
  year += 1;
  return year;
}

// =================================================================================================

describe('the start screen (3.14.2)', () => {
  it('lists every published teaching newest first, with its question count, series and tags', async () => {
    const y = nextYear();
    const study = await insertSeries({ title: `Study ${RUN}`, description: null }, handle);
    const older = await teaching(`Older ${RUN}`, `${y}-01-01`, 2);
    const newer = await teaching(`Newer ${RUN}`, `${y}-02-01`, 3);
    const plain = await teaching(`Plain ${RUN}`, `${y}-03-01`, 0);
    await teaching(`Hidden ${RUN}`, `${y}-04-01`, 3, false);
    await setRecordingSeries(newer.id, study.id, handle);
    const tag = await insertTag(`grace-${RUN}-${y}`, handle);
    await insertTagQuestion(tag.id, 'Where did grace meet you?', handle);
    await replaceRecordingTags(newer.id, [tag.id], handle);

    const listed = await call<FlowTeachingsPayload>(FLOW_TEACHINGS_PATH, { cookie: alice.cookie });
    expect(listed.status).toBe(200);
    const mine = listed.body.teachings.filter((one) => [older.id, newer.id, plain.id].includes(one.id));
    expect(mine.map((one) => one.id)).toEqual([plain.id, newer.id, older.id]);
    expect(mine.map((one) => one.questionCount)).toEqual([1, 3, 2]);
    expect(mine[1]?.series?.title).toBe(`Study ${RUN}`);
    expect(mine[1]?.tagIds).toEqual([tag.id]);
    expect(listed.body.tagQuestionCounts[tag.id]).toBe(1);
    expect(listed.body.teachings.some((one) => one.title === `Hidden ${RUN}`)).toBe(false);

    expect((await call(FLOW_TEACHINGS_PATH, {})).status).toBe(401);
  });
});

describe('starting a session (3.14.2, 3.14.3, 3.14.5, 3.14.10)', () => {
  it('asks only the picked teachings, newest first, last chapter first, a chapterless teaching once, and each tag once at the end', async () => {
    const y = nextYear();
    const first = await teaching(`First ${RUN} ${y}`, `${y}-01-01`, 2);
    const second = await teaching(`Second ${RUN} ${y}`, `${y}-02-01`, 0);
    const third = await teaching(`Third ${RUN} ${y}`, `${y}-03-01`, 3);
    const skipped = await teaching(`Skipped ${RUN} ${y}`, `${y}-02-15`, 2);
    const tag = await insertTag(`hope-${RUN}-${y}`, handle);
    await insertTagQuestion(tag.id, 'Where did hope hold?', handle);
    await insertTagQuestion(tag.id, 'Where did it not?', handle);
    await replaceRecordingTags(first.id, [tag.id], handle);
    await replaceRecordingTags(third.id, [tag.id], handle);
    // A tag only the unpicked teaching carries contributes nothing.
    const elsewhere = await insertTag(`elsewhere-${RUN}-${y}`, handle);
    await insertTagQuestion(elsewhere.id, 'Never asked?', handle);
    await replaceRecordingTags(skipped.id, [elsewhere.id], handle);

    // Picked in no particular order, and one of them twice: the session is the set, in library order.
    const session = await started(alice, [first.id, third.id, second.id, first.id]);
    try {
      expect(session.status).toBe('in_progress');
      expect(session.teachings.map((one) => one.id)).toEqual([third.id, second.id, first.id]);
      expect(session.teachingCount).toBe(3);
      expect(session.questionCount).toBe(8);
      expect(session.readingList).toBeNull();

      const order = session.items.map((one) =>
        one.kind === 'tag' ? `tag:${one.tag?.name}` : `${one.recording?.title}:${one.chapter?.title ?? 'whole'}`,
      );
      expect(order).toEqual([
        `Third ${RUN} ${y}:Third ${RUN} ${y} ch3`,
        `Third ${RUN} ${y}:Third ${RUN} ${y} ch2`,
        `Third ${RUN} ${y}:Third ${RUN} ${y} ch1`,
        `Second ${RUN} ${y}:whole`,
        `First ${RUN} ${y}:First ${RUN} ${y} ch2`,
        `First ${RUN} ${y}:First ${RUN} ${y} ch1`,
        `tag:hope-${RUN}-${y}`,
        `tag:hope-${RUN}-${y}`,
      ]);
      expect(session.items.map((one) => one.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(session.items[0]?.chapter).toMatchObject({ id: third.chapterIds[2], summary: `Summary of Third ${RUN} ${y} ch3.`, startMs: 40 * MINUTE });
      expect(session.items[0]?.question).toBe(`Q about Third ${RUN} ${y} ch3?`);
      expect(session.items.every((one) => one.rating === null)).toBe(true);

      // The page lists it as the one in progress, naming what it covers.
      const mine = await call<FlowSessionsPayload>(FLOW_SESSIONS_PATH, { cookie: alice.cookie });
      expect(mine.body.active?.id).toBe(session.id);
      expect(mine.body.active?.teachings.map((one) => one.title)).toEqual([`Third ${RUN} ${y}`, `Second ${RUN} ${y}`, `First ${RUN} ${y}`]);
      expect(mine.body.completed.some((one) => one.id === session.id)).toBe(false);

      // A second start is refused while this one runs, and says what to do.
      const again = await start(alice, [first.id]);
      expect(again.status).toBe(409);
      expect(again.code).toBe('flow_session_in_progress');
    } finally {
      await abandon(alice, session.id);
    }
  });

  it('asks about one teaching alone when one is picked', async () => {
    const y = nextYear();
    await teaching(`Newer alone ${RUN} ${y}`, `${y}-02-01`, 2);
    const only = await teaching(`Only ${RUN} ${y}`, `${y}-01-01`, 2);
    const session = await started(alice, [only.id]);
    try {
      expect(session.teachingCount).toBe(1);
      expect(session.teachings.map((one) => one.id)).toEqual([only.id]);
      expect(session.items.map((one) => one.recording?.id)).toEqual([only.id, only.id]);
    } finally {
      await abandon(alice, session.id);
    }
  });

  it('refuses a malformed body, an empty pick, an unpublished teaching, a made-up one, and no session', async () => {
    const y = nextYear();
    const hidden = await teaching(`Unpublished ${RUN} ${y}`, `${y}-01-01`, 2, false);
    const shown = await teaching(`Shown ${RUN} ${y}`, `${y}-02-01`, 2);
    expect((await start(alice, 'nope')).code).toBe('invalid_input');
    expect((await start(alice, [])).code).toBe('invalid_input');
    expect((await start(alice, [42])).code).toBe('invalid_input');
    expect((await start(alice, [hidden.id])).code).toBe('not_found');
    expect((await start(alice, [MADE_UP_ID])).code).toBe('not_found');
    // One bad id refuses the whole pick: nothing is started.
    expect((await start(alice, [shown.id, hidden.id])).code).toBe('not_found');
    expect((await call<FlowSessionsPayload>(FLOW_SESSIONS_PATH, { cookie: alice.cookie })).body.active).toBeNull();
    expect((await call(FLOW_SESSIONS_PATH, { method: 'POST', body: { recordingIds: [shown.id] } })).status).toBe(401);
  });

  it('abandons a session, after which another can start', async () => {
    const y = nextYear();
    const one = await teaching(`Abandoned ${RUN} ${y}`, `${y}-01-01`, 2);
    const session = await started(alice, [one.id]);
    const gone = await abandon(alice, session.id);
    expect(gone.status).toBe(200);
    expect(gone.body.session.status).toBe('abandoned');
    // Not listed among the completed, and not the active one.
    const mine = await call<FlowSessionsPayload>(FLOW_SESSIONS_PATH, { cookie: alice.cookie });
    expect(mine.body.active).toBeNull();
    expect(mine.body.completed.some((entry) => entry.id === session.id)).toBe(false);
    // It no longer takes answers.
    expect((await answer(alice, session.id, session.items[0]!.id, 4)).code).toBe('invalid_input');

    const next = await started(alice, [one.id]);
    expect(next.id).not.toBe(session.id);
    await abandon(alice, next.id);
  });
});

describe('answering, and the reading list (3.14.6, 3.14.7, 3.14.9)', () => {
  it('takes a rating from 1 to 5, replaces on a second press, completes on the last, and lists 3 and below oldest first', async () => {
    const y = nextYear();
    const older = await teaching(`Earlier ${RUN} ${y}`, `${y}-01-01`, 2);
    const newer = await teaching(`Later ${RUN} ${y}`, `${y}-02-01`, 2);
    // A link out of the older teaching's second chapter into the newer teaching's first.
    await replaceCrossReferencesForRun(
      older.id,
      [
        {
          sourceRecordingId: older.id,
          sourceSegmentId: older.segmentIds[2]!,
          targetRecordingId: newer.id,
          targetSegmentId: newer.segmentIds[0]!,
          score: 0.8,
          basis: 'semantic',
        },
      ],
      handle,
    );

    const session = await started(alice, [older.id, newer.id]);
    const [newerCh2, newerCh1, olderCh2, olderCh1] = session.items;

    // Not on the scale.
    expect((await answer(alice, session.id, newerCh2!.id, 'maybe')).code).toBe('invalid_input');
    expect((await answer(alice, session.id, newerCh2!.id, 0)).code).toBe('invalid_input');
    expect((await answer(alice, session.id, newerCh2!.id, 6)).code).toBe('invalid_input');
    expect((await answer(alice, session.id, newerCh2!.id, '3')).code).toBe('invalid_input');
    expect((await answer(alice, session.id, MADE_UP_ID, 4)).code).toBe('not_found');

    let latest = (await answer(alice, session.id, newerCh2!.id, 4)).body.session;
    expect(latest.answeredCount).toBe(1);
    expect(latest.items[0]?.rating).toBe(4);
    // Stepping back and changing the answer replaces it.
    latest = (await answer(alice, session.id, newerCh2!.id, 1)).body.session;
    expect(latest.items[0]?.rating).toBe(1);
    expect(latest.answeredCount).toBe(1);
    expect(latest.status).toBe('in_progress');

    await answer(alice, session.id, newerCh1!.id, 5);
    await answer(alice, session.id, olderCh2!.id, 3);
    const last = await answer(alice, session.id, olderCh1!.id, 2);
    expect(last.status).toBe(200);
    latest = last.body.session;

    // The last answer completed it, and the reading list came back with that answer.
    expect(latest.status).toBe('complete');
    expect(latest.completedAt).not.toBeNull();
    expect(latest.gapCount).toBe(3);
    const list = latest.readingList ?? [];
    expect(list.map((group) => group.recording?.title)).toEqual([`Earlier ${RUN} ${y}`, `Later ${RUN} ${y}`]);
    // Oldest teaching first, and within it the first chapter first — the reading order.
    expect(list[0]?.rows.map((row) => row.item.chapter?.title)).toEqual([`Earlier ${RUN} ${y} ch1`, `Earlier ${RUN} ${y} ch2`]);
    expect(list[0]?.rows.map((row) => row.item.rating)).toEqual([2, 3]);
    // The one rated 5 is not on the list; the one rated 1 is.
    expect(list[1]?.rows.map((row) => row.item.chapter?.title)).toEqual([`Later ${RUN} ${y} ch2`]);
    // The related chapter of the other teaching sits beneath the row whose span the link left from.
    expect(list[0]?.rows[1]?.related).toEqual([
      {
        recording: expect.objectContaining({ id: newer.id, title: `Later ${RUN} ${y}` }),
        chapter: { id: newer.chapterIds[0], title: `Later ${RUN} ${y} ch1`, summary: null, startMs: 0 },
      },
    ]);
    expect(list[0]?.rows[0]?.related).toEqual([]);

    // Tick a row off, and un-tick it.
    const ticked = await call<FlowSessionPayload>(flowSessionItemDonePath(session.id, olderCh1!.id), {
      method: 'PUT',
      cookie: alice.cookie,
      body: { done: true },
    });
    expect(ticked.status).toBe(200);
    expect(ticked.body.session.readingList?.[0]?.rows[0]?.item.done).toBe(true);
    expect((await call(flowSessionItemDonePath(session.id, olderCh1!.id), { method: 'PUT', cookie: alice.cookie, body: { done: 'yes' } })).code).toBe('invalid_input');

    // A completed session no longer takes answers, and the page lists it as completed.
    expect((await answer(alice, session.id, olderCh1!.id, 4)).code).toBe('invalid_input');
    const mine = await call<FlowSessionsPayload>(FLOW_SESSIONS_PATH, { cookie: alice.cookie });
    expect(mine.body.active).toBeNull();
    expect(mine.body.completed[0]).toMatchObject({ id: session.id, gapCount: 3, questionCount: 4, answeredCount: 4 });
    expect(mine.body.completed[0]?.teachings.map((one) => one.id)).toEqual([newer.id, older.id]);
  });

  it('completes at once, with an empty list, when the pick has nothing to ask', async () => {
    const y = nextYear();
    const row = await insertRecording(
      { originalMediaKey: `originals/flow-empty-${RUN}.mp3`, title: `Empty ${RUN}`, recordedAt: `${y}-01-01` },
      handle,
    );
    await setRecordingPublication(row.id, new Date(), handle);
    const session = await started(alice, [row.id]);
    expect(session.status).toBe('complete');
    expect(session.items).toEqual([]);
    expect(session.readingList).toEqual([]);
    // With no items to read the pick off, the page still names the teaching.
    expect(session.teachings.map((one) => one.id)).toEqual([row.id]);
  });
});

describe('snapshots (3.14.10)', () => {
  it('keeps an answered item whose chapter has gone, and drops an unanswered one', async () => {
    const y = nextYear();
    const one = await teaching(`Snapshot ${RUN} ${y}`, `${y}-01-01`, 3);
    const session = await started(alice, [one.id]);
    const [ch3, ch2, ch1] = session.items;
    await answer(alice, session.id, ch3!.id, 3);

    await deleteChapter(one.chapterIds[2]!, handle); // ch3, answered
    await deleteChapter(one.chapterIds[0]!, handle); // ch1, not answered

    const read = await call<FlowSessionPayload>(flowSessionPath(session.id), { cookie: alice.cookie });
    expect(read.body.session.items.map((item) => item.id)).toEqual([ch3!.id, ch2!.id]);
    expect(read.body.session.items[0]).toMatchObject({
      rating: 3,
      chapter: { id: null, title: `Snapshot ${RUN} ${y} ch3` },
      question: `Q about Snapshot ${RUN} ${y} ch3?`,
    });
    expect(read.body.session.questionCount).toBe(2);

    // Answering the one left completes it; the row with no chapter opens the teaching instead.
    const done = await answer(alice, session.id, ch2!.id, 4);
    expect(done.body.session.status).toBe('complete');
    expect(done.body.session.readingList?.[0]?.rows[0]?.item.chapter?.id).toBeNull();
    expect(ch1).toBeDefined();
  });
});

describe('it is the member’s own (3.14.8)', () => {
  it('shows nobody else’s session, and lets nobody else answer, abandon or tick it', async () => {
    const y = nextYear();
    const one = await teaching(`Private ${RUN} ${y}`, `${y}-01-01`, 2);
    const session = await started(alice, [one.id]);
    try {
      expect((await call(flowSessionPath(session.id), { cookie: bob.cookie })).code).toBe('not_found');
      expect((await answer(bob, session.id, session.items[0]!.id, 4)).code).toBe('not_found');
      expect((await abandon(bob, session.id)).code).toBe('not_found');
      expect((await call(flowSessionItemDonePath(session.id, session.items[0]!.id), { method: 'PUT', cookie: bob.cookie, body: { done: true } })).code).toBe('not_found');
      const bobs = await call<FlowSessionsPayload>(FLOW_SESSIONS_PATH, { cookie: bob.cookie });
      expect(bobs.body.active).toBeNull();
      expect((await call(flowSessionPath(session.id), {})).status).toBe(401);
      expect((await call(flowSessionPath('not-an-id'), { cookie: alice.cookie })).code).toBe('invalid_input');
    } finally {
      await abandon(alice, session.id);
    }
  });
});

describe('curating questions (3.14.11)', () => {
  it('lets an admin rewrite a chapter’s question, which rides the chapter list; a member is refused', async () => {
    const y = nextYear();
    const one = await teaching(`Curated ${RUN} ${y}`, `${y}-01-01`, 2);
    const chapterId = one.chapterIds[0]!;

    const before = await call<ChaptersPayload>(recordingChaptersPath(one.id), { cookie: alice.cookie });
    expect(before.body.chapters[0]?.question).toBe(`Q about Curated ${RUN} ${y} ch1?`);

    const rewritten = await call<ChapterQuestionPayload>(chapterQuestionPath(chapterId), {
      method: 'PUT',
      cookie: admin.cookie,
      body: { text: '  What did you do first?  ' },
    });
    expect(rewritten.status).toBe(200);
    expect(rewritten.body).toEqual({ chapterId, question: 'What did you do first?' });

    const after = await call<ChaptersPayload>(recordingChaptersPath(one.id), { cookie: alice.cookie });
    expect(after.body.chapters[0]?.question).toBe('What did you do first?');

    // A session started now asks the rewritten question.
    const session = await started(alice, [one.id]);
    expect(session.items.find((item) => item.chapter?.id === chapterId)?.question).toBe('What did you do first?');
    await abandon(alice, session.id);

    expect((await call(chapterQuestionPath(chapterId), { method: 'PUT', cookie: alice.cookie, body: { text: 'Mine.' } })).status).toBe(403);
    expect((await call(chapterQuestionPath(chapterId), { method: 'PUT', cookie: admin.cookie, body: { text: '   ' } })).code).toBe('invalid_input');
    expect((await call(chapterQuestionPath(chapterId), { method: 'PUT', cookie: admin.cookie, body: { text: 'x'.repeat(501) } })).code).toBe('invalid_input');
    expect((await call(chapterQuestionPath(MADE_UP_ID), { method: 'PUT', cookie: admin.cookie, body: { text: 'Fine.' } })).code).toBe('not_found');
  });

  it('lets an admin add to, rewrite and remove from a tag’s bank; a member is refused', async () => {
    const tag = await insertTag(`bank-${RUN}`, handle);
    const empty = await call<TagQuestionsPayload>(tagQuestionsPath(tag.id), { cookie: admin.cookie });
    expect(empty.body.questions).toEqual([]);

    const added = await call<TagQuestionsPayload>(tagQuestionsPath(tag.id), { method: 'POST', cookie: admin.cookie, body: { text: 'First?' } });
    expect(added.status).toBe(200);
    const twice = await call<TagQuestionsPayload>(tagQuestionsPath(tag.id), { method: 'POST', cookie: admin.cookie, body: { text: 'Second?' } });
    expect(twice.body.questions.map((one) => one.text)).toEqual(['First?', 'Second?']);

    const first = twice.body.questions[0]!;
    const edited = await call<TagQuestionsPayload>(tagQuestionPath(tag.id, first.id), { method: 'PUT', cookie: admin.cookie, body: { text: 'First, rewritten?' } });
    expect(edited.body.questions.map((one) => one.text)).toEqual(['First, rewritten?', 'Second?']);

    const removed = await call<TagQuestionsPayload>(tagQuestionPath(tag.id, first.id), { method: 'DELETE', cookie: admin.cookie });
    expect(removed.body.questions.map((one) => one.text)).toEqual(['Second?']);
    // Removing it again is an end state the admin is already in.
    expect((await call(tagQuestionPath(tag.id, first.id), { method: 'DELETE', cookie: admin.cookie })).status).toBe(200);

    expect((await call(tagQuestionsPath(tag.id), { cookie: alice.cookie })).status).toBe(403);
    expect((await call(tagQuestionsPath(tag.id), { method: 'POST', cookie: alice.cookie, body: { text: 'Mine.' } })).status).toBe(403);
    expect((await call(tagQuestionsPath(MADE_UP_ID), { cookie: admin.cookie })).code).toBe('not_found');
    expect((await call(tagQuestionPath(tag.id, MADE_UP_ID), { method: 'PUT', cookie: admin.cookie, body: { text: 'Fine.' } })).code).toBe('not_found');
  });
});
