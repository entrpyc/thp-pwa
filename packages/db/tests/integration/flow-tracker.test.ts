import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  answerFlowSessionItem,
  completeFlowSession,
  countQuestionsByRecording,
  countQuestionsByTag,
  countUnansweredFlowItems,
  createDatabase,
  deleteChapter,
  deleteQuestionsOfChapters,
  deleteRecordingQuestion,
  deleteTag,
  deleteUserAccount,
  findActiveFlowSessionForMember,
  findFlowSessionForMember,
  findRecordingQuestion,
  insertFlowSession,
  insertGeneratedQuestions,
  insertRecording,
  listFlowSessionTeachings,
  insertTag,
  insertTagQuestion,
  insertUser,
  isUniqueViolation,
  listChapterQuestionsForRecording,
  listChaptersMissingQuestions,
  listFlowSessionItems,
  listFlowSessionsForMember,
  listQuestionsForRecordings,
  listRelatedChapters,
  listSegments,
  listTagQuestions,
  replaceChapters,
  replaceCrossReferencesForRun,
  replaceTranscript,
  runMigrations,
  setChapterQuestion,
  setFlowSessionItemDone,
  setRecordingPublication,
  type DatabaseHandle,
  type NewFlowSessionItem,
} from '@thp/db';
import { ROLE } from '@thp/shared';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';

/**
 * **The Flow Tracker's three tables** ([3.14](docs/project/prd.md); [4.12](docs/project/prd.md),
 * [4.13](docs/project/prd.md)), against a real database.
 *
 * Real because the properties under test are properties of the *tables*: that a question sits on
 * exactly one thing and goes with it, that one member has one session in progress, that an
 * unanswered item whose chapter has gone is dropped while an answered one keeps its place, and that
 * a deleted account takes its sessions with it ([3.1.9](docs/project/prd.md)). None of those is
 * assertable against a fake.
 */

const databaseUrl = inject('databaseUrl');
const MINUTE = 60_000;
const GENERATED = { model: 'fake', modelVersion: 'fake-1', promptVersion: 'reflections-1' };
const CHAPTERS_BY = { model: 'fake', modelVersion: 'fake-1', promptVersion: 'chapters-1' };

let target: ThrowawayDatabase;
let handle: DatabaseHandle;
let sql: postgres.Sql;
let made = 0;

async function member(label: string): Promise<string> {
  made += 1;
  const row = await insertUser(
    {
      email: `${label}-${made}@example.test`,
      displayName: label,
      passwordHash: 'not-a-hash',
      role: ROLE.member,
    },
    handle,
  );
  return row.id;
}

/** A published teaching with a six-line transcript and, by default, three chapters. */
async function teaching(options: { chapters?: number; recordedAt?: string } = {}): Promise<{
  id: string;
  chapterIds: string[];
  segmentIds: string[];
}> {
  made += 1;
  const row = await insertRecording(
    {
      originalMediaKey: `originals/flow-${made}-${Date.now().toString(36)}.mp3`,
      title: `Teaching ${made}`,
      recordedAt: options.recordedAt ?? '2026-08-16',
    },
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
        text: `Line ${index + 1}.`,
      })),
    },
    handle,
  );
  const count = options.chapters ?? 3;
  const chapters = await replaceChapters(
    row.id,
    Array.from({ length: count }, (_unused, index) => ({
      startMs: index * 20 * MINUTE,
      title: `Chapter ${index + 1}`,
      summary: `About part ${index + 1}.`,
    })),
    CHAPTERS_BY,
    handle,
  );
  await setRecordingPublication(row.id, new Date(), handle);
  return {
    id: row.id,
    chapterIds: chapters.map((one) => one.id),
    segmentIds: (await listSegments(transcript.id, handle)).map((one) => one.id),
  };
}

function chapterItem(recordingId: string, chapterId: string | null, title: string): NewFlowSessionItem {
  return {
    kind: 'chapter',
    recordingId,
    chapterId,
    tagId: null,
    question: `How has “${title}” shown up this week?`,
    title,
    summary: 'About it.',
    startMs: 0,
  };
}

beforeAll(async () => {
  target = await createThrowawayDatabase(databaseUrl, 'flow_tracker');
  await runMigrations({ url: target.url });
  handle = createDatabase({ url: target.url, max: 6 });
  sql = postgres(target.url, { max: 2, onnotice: () => {} });
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await sql?.end({ timeout: 5 });
  await target?.drop();
}, 60_000);

// =================================================================================================

describe('questions (3.14.4, 3.14.11, 3.14.12)', () => {
  it('finds the chapters with no question, writes one each, and then finds none', async () => {
    const { id, chapterIds } = await teaching();
    expect((await listChaptersMissingQuestions(id, handle)).map((one) => one.id)).toEqual(chapterIds);

    const written = await insertGeneratedQuestions(
      chapterIds.map((chapterId) => ({ scope: 'chapter' as const, chapterId, text: 'Q?', generatedBy: GENERATED })),
      handle,
    );
    expect(written).toBe(3);
    expect(await listChaptersMissingQuestions(id, handle)).toEqual([]);

    const onChapters = await listChapterQuestionsForRecording(id, handle);
    expect([...onChapters.keys()].sort()).toEqual([...chapterIds].sort());
    expect(onChapters.get(chapterIds[0]!)?.editedByAdmin).toBe(false);
    expect((await countQuestionsByRecording(handle)).get(id)).toBe(3);
  });

  it('holds one question per chapter and one per chapterless recording, and refuses a second', async () => {
    const { chapterIds } = await teaching();
    const first = chapterIds[0]!;
    await insertGeneratedQuestions([{ scope: 'chapter', chapterId: first, text: 'Once.', generatedBy: GENERATED }], handle);
    await expect(
      insertGeneratedQuestions([{ scope: 'chapter', chapterId: first, text: 'Twice.', generatedBy: GENERATED }], handle),
    ).rejects.toSatisfy(isUniqueViolation);

    const plain = await teaching({ chapters: 0 });
    await insertGeneratedQuestions([{ scope: 'recording', recordingId: plain.id, text: 'Whole.', generatedBy: GENERATED }], handle);
    expect((await findRecordingQuestion(plain.id, handle))?.text).toBe('Whole.');
    await expect(
      insertGeneratedQuestions([{ scope: 'recording', recordingId: plain.id, text: 'Again.', generatedBy: GENERATED }], handle),
    ).rejects.toSatisfy(isUniqueViolation);
    expect(await deleteRecordingQuestion(plain.id, handle)).toBe(true);
    expect(await findRecordingQuestion(plain.id, handle)).toBeNull();
  });

  it('refuses a question on nothing, or on two things at once', async () => {
    const { id, chapterIds } = await teaching();
    await expect(
      sql`insert into flow_question (scope, text) values ('chapter', 'On nothing.')`,
    ).rejects.toThrow(/flow_question_shape/);
    await expect(
      sql`insert into flow_question (scope, chapter_id, recording_id, text)
          values ('chapter', ${chapterIds[0]!}, ${id}, 'On two.')`,
    ).rejects.toThrow(/flow_question_shape/);
    await expect(
      sql`insert into flow_question (scope, chapter_id, text) values ('chapter', ${chapterIds[0]!}, '')`,
    ).rejects.toThrow(/flow_question_text_length/);
  });

  it('follows its chapter: deleting the chapter takes the question with it', async () => {
    const { id, chapterIds } = await teaching();
    await insertGeneratedQuestions(
      chapterIds.map((chapterId) => ({ scope: 'chapter' as const, chapterId, text: 'Q?', generatedBy: GENERATED })),
      handle,
    );
    await deleteChapter(chapterIds[2]!, handle);
    expect([...(await listChapterQuestionsForRecording(id, handle)).keys()].sort()).toEqual(
      [chapterIds[0]!, chapterIds[1]!].sort(),
    );
    // And a merge's survivor has its question removed on purpose, so the step writes a fresh one.
    expect(await deleteQuestionsOfChapters([chapterIds[1]!], handle)).toBe(1);
    expect((await listChaptersMissingQuestions(id, handle)).map((one) => one.id)).toEqual([chapterIds[1]]);
  });

  it('lets an admin rewrite a question in place, or write one before the step has', async () => {
    const { chapterIds } = await teaching();
    const typed = await setChapterQuestion(chapterIds[0]!, 'What did you do first?', handle);
    expect(typed.editedByAdmin).toBe(true);
    expect(typed.generatedBy).toBeNull();

    await insertGeneratedQuestions([{ scope: 'chapter', chapterId: chapterIds[1]!, text: 'Model.', generatedBy: GENERATED }], handle);
    const rewritten = await setChapterQuestion(chapterIds[1]!, 'Admin.', handle);
    expect(rewritten.text).toBe('Admin.');
    expect(rewritten.editedByAdmin).toBe(true);
    // Still one row for that chapter.
    expect((await listChaptersMissingQuestions(typed.chapterId === null ? '' : rewritten.chapterId ?? '', handle)).length).toBe(0);
  });

  it('keeps a tag’s bank, oldest first, and takes it with the tag', async () => {
    const tag = await insertTag(`grace-${made}`, handle);
    const first = await insertTagQuestion(tag.id, 'Where did grace meet you?', handle);
    await insertTagQuestion(tag.id, 'Who did you extend it to?', handle);
    expect((await listTagQuestions(tag.id, handle)).map((one) => one.text)).toEqual([
      'Where did grace meet you?',
      'Who did you extend it to?',
    ]);
    expect((await countQuestionsByTag(handle)).get(tag.id)).toBe(2);
    expect(first.scope).toBe('tag');

    await deleteTag(tag.id, handle);
    expect(await listTagQuestions(tag.id, handle)).toEqual([]);
  });

  it('answers every generated question on a set of teachings, with the chapter it is on', async () => {
    const a = await teaching();
    const b = await teaching({ chapters: 0 });
    await insertGeneratedQuestions(
      [
        ...a.chapterIds.map((chapterId) => ({ scope: 'chapter' as const, chapterId, text: 'Q?', generatedBy: GENERATED })),
        { scope: 'recording' as const, recordingId: b.id, text: 'Whole?', generatedBy: GENERATED },
      ],
      handle,
    );
    const rows = await listQuestionsForRecordings([a.id, b.id], handle);
    expect(rows).toHaveLength(4);
    expect(rows.filter((one) => one.recordingId === a.id).map((one) => one.chapterStartMs).sort((x, y) => x! - y!)).toEqual([
      0,
      20 * MINUTE,
      40 * MINUTE,
    ]);
    expect(rows.find((one) => one.scope === 'recording')).toMatchObject({ recordingId: b.id, chapterId: null });
  });
});

// =================================================================================================

describe('sessions (3.14.8, 3.14.10)', () => {
  it('holds one session in progress per member, and lists them newest first', async () => {
    const who = await member('one-at-a-time');
    const { id, chapterIds } = await teaching();
    const items = chapterIds.map((chapterId, index) => chapterItem(id, chapterId, `Chapter ${index + 1}`));

    const first = await insertFlowSession({ userId: who, divergenceRecordingId: id, teachingCount: 1, items }, handle);
    await expect(
      insertFlowSession({ userId: who, divergenceRecordingId: id, teachingCount: 1, items }, handle),
    ).rejects.toSatisfy(isUniqueViolation);

    expect((await findActiveFlowSessionForMember(who, handle))?.id).toBe(first.id);
    const listed = await listFlowSessionsForMember(who, handle);
    expect(listed.map((one) => one.id)).toEqual([first.id]);
    expect(listed[0]).toMatchObject({ questionCount: 3, answeredCount: 0, gapCount: 0, divergenceTitle: `Teaching ${made}` });

    // Complete it, and a second can start.
    expect(await completeFlowSession(first.id, who, handle)).toBe(true);
    expect(await completeFlowSession(first.id, who, handle)).toBe(false);
    const second = await insertFlowSession({ userId: who, divergenceRecordingId: id, teachingCount: 1, items }, handle);
    expect((await listFlowSessionsForMember(who, handle)).map((one) => one.id)).toEqual([second.id, first.id]);
  });

  it('is the member’s own: another member’s id finds nothing', async () => {
    const alice = await member('alice');
    const bob = await member('bob');
    const { id, chapterIds } = await teaching();
    const session = await insertFlowSession(
      { userId: alice, divergenceRecordingId: id, teachingCount: 1, items: [chapterItem(id, chapterIds[0]!, 'One')] },
      handle,
    );
    expect(await findFlowSessionForMember(session.id, bob, handle)).toBeNull();
    expect(await findFlowSessionForMember(session.id, alice, handle)).not.toBeNull();
    expect(await listFlowSessionsForMember(bob, handle)).toEqual([]);
  });

  it('answers, counts gaps, completes when nothing is left, and ticks the list', async () => {
    const who = await member('answers');
    const { id, chapterIds } = await teaching();
    const session = await insertFlowSession(
      {
        userId: who,
        divergenceRecordingId: id,
        teachingCount: 1,
        items: chapterIds.map((chapterId, index) => chapterItem(id, chapterId, `Chapter ${index + 1}`)),
      },
      handle,
    );
    const items = await listFlowSessionItems(session.id, handle);
    expect(items.map((one) => one.position)).toEqual([1, 2, 3]);
    expect(items[0]).toMatchObject({ recordingTitle: `Teaching ${made}`, summary: 'About it.' });

    // The tokens are the scale's rungs in order: the first three are gaps, the last two are not.
    expect(await answerFlowSessionItem(session.id, items[0]!.id, 'dont_remember', handle)).toBe(true);
    expect(await answerFlowSessionItem(session.id, items[1]!.id, 'not_embodied', handle)).toBe(true);
    // Changing an answer replaces it.
    expect(await answerFlowSessionItem(session.id, items[1]!.id, 'remember_well', handle)).toBe(true);
    expect(await countUnansweredFlowItems(session.id, handle)).toBe(1);
    // Another session's item id writes nothing here.
    expect(await answerFlowSessionItem('00000000-0000-4000-8000-000000000000', items[2]!.id, 'remember_well', handle)).toBe(false);

    expect(await answerFlowSessionItem(session.id, items[2]!.id, 'experience_daily', handle)).toBe(true);
    expect(await countUnansweredFlowItems(session.id, handle)).toBe(0);
    expect(await completeFlowSession(session.id, who, handle)).toBe(true);

    const summary = await findFlowSessionForMember(session.id, who, handle);
    expect(summary).toMatchObject({ status: 'complete', questionCount: 3, answeredCount: 3, gapCount: 2 });
    // The teachings the session asked about, read off its items.
    const asked = await listFlowSessionTeachings([session.id], handle);
    expect(asked.get(session.id)?.map((one) => one.recordingId)).toEqual([id]);
    expect((await listFlowSessionTeachings([], handle)).size).toBe(0);
    expect(summary?.completedAt).not.toBeNull();

    expect(await setFlowSessionItemDone(session.id, items[0]!.id, true, handle)).toBe(true);
    expect((await listFlowSessionItems(session.id, handle))[0]?.doneAt).not.toBeNull();
    expect(await setFlowSessionItemDone(session.id, items[0]!.id, false, handle)).toBe(true);
    expect((await listFlowSessionItems(session.id, handle))[0]?.doneAt).toBeNull();
  });

  it('refuses a status without its timestamp, and an answer without its moment', async () => {
    const who = await member('shape');
    const { id, chapterIds } = await teaching();
    const session = await insertFlowSession(
      { userId: who, divergenceRecordingId: id, teachingCount: 1, items: [chapterItem(id, chapterIds[0]!, 'One')] },
      handle,
    );
    await expect(sql`update flow_session set status = 'complete' where id = ${session.id}`).rejects.toThrow(
      /flow_session_status_timestamps/,
    );
    await expect(
      sql`update flow_session_item set answer = 'remember_well' where session_id = ${session.id}`,
    ).rejects.toThrow(/flow_session_item_shape/);
  });

  /**
   * 3.14.10 — a session snapshots what it asked. The chapter going (a regeneration, a merge) drops
   * an item nobody answered yet, and keeps the place of one somebody did.
   */
  it('drops an unanswered item whose chapter has gone and keeps an answered one', async () => {
    const who = await member('snapshot');
    const { id, chapterIds } = await teaching();
    const session = await insertFlowSession(
      {
        userId: who,
        divergenceRecordingId: id,
        teachingCount: 1,
        items: chapterIds.map((chapterId, index) => chapterItem(id, chapterId, `Chapter ${index + 1}`)),
      },
      handle,
    );
    const before = await listFlowSessionItems(session.id, handle);
    await answerFlowSessionItem(session.id, before[0]!.id, 'recall_slightly', handle);

    // The first chapter (answered) and the third (not) are deleted — a regeneration in miniature.
    await deleteChapter(chapterIds[0]!, handle);
    await deleteChapter(chapterIds[2]!, handle);

    const after = await listFlowSessionItems(session.id, handle);
    expect(after.map((one) => one.position)).toEqual([1, 2]);
    // The answered one keeps its words and its answer, with no chapter behind it any more.
    expect(after[0]).toMatchObject({ chapterId: null, title: 'Chapter 1', answer: 'recall_slightly' });
    expect(after[1]).toMatchObject({ chapterId: chapterIds[1], answer: null });
    expect(await countUnansweredFlowItems(session.id, handle)).toBe(1);
    expect((await findFlowSessionForMember(session.id, who, handle))?.questionCount).toBe(2);
  });

  it('goes with the account (3.1.9)', async () => {
    const who = await member('deleted');
    const { id, chapterIds } = await teaching();
    const session = await insertFlowSession(
      { userId: who, divergenceRecordingId: id, teachingCount: 1, items: [chapterItem(id, chapterIds[0]!, 'One')] },
      handle,
    );
    await deleteUserAccount(who, handle);
    const rows = await sql`select id from flow_session where id = ${session.id}`;
    expect(rows).toHaveLength(0);
    const items = await sql`select id from flow_session_item where session_id = ${session.id}`;
    expect(items).toHaveLength(0);
  });
});

// =================================================================================================

describe('related chapters (3.14.6, 3.9.8)', () => {
  it('follows the links out of a span to the chapters they land in, strongest first, one row per chapter', async () => {
    const source = await teaching();
    const other = await teaching();
    const unpublished = await teaching();
    await setRecordingPublication(unpublished.id, null, handle);

    // Three links out of the source's first chapter (lines 1 and 2, inside [0, 20min)): two into
    // the other teaching's first chapter — the stronger wins the row — and one into its third;
    // one from the source's *second* chapter, which is outside the span and must not count; and one
    // into an unpublished teaching, which never shows.
    await replaceCrossReferencesForRun(
      source.id,
      [
        link(source, 0, other, 0, 0.9),
        link(source, 1, other, 1, 0.7),
        link(source, 1, other, 5, 0.6),
        link(source, 2, other, 4, 0.95),
        link(source, 0, unpublished, 0, 0.99),
      ],
      handle,
    );

    const related = await listRelatedChapters(source.id, 0, 20 * MINUTE, 3, handle);
    expect(related.map((one) => [one.chapterTitle, one.score])).toEqual([
      ['Chapter 1', 0.9],
      ['Chapter 3', 0.6],
    ]);
    expect(related[0]).toMatchObject({ recordingId: other.id, chapterStartMs: 0, recordedAt: '2026-08-16' });

    // The limit holds, and a span with no links answers nothing.
    expect(await listRelatedChapters(source.id, 0, 20 * MINUTE, 1, handle)).toHaveLength(1);
    expect(await listRelatedChapters(source.id, 40 * MINUTE, 60 * MINUTE, 3, handle)).toEqual([]);
  });
});

function link(
  from: { id: string; segmentIds: string[] },
  fromLine: number,
  to: { id: string; segmentIds: string[] },
  toLine: number,
  score: number,
) {
  return {
    sourceRecordingId: from.id,
    sourceSegmentId: from.segmentIds[fromLine]!,
    targetRecordingId: to.id,
    targetSegmentId: to.segmentIds[toLine]!,
    score,
    basis: 'semantic' as const,
  };
}
