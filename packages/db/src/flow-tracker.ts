import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FlowAnswer, FlowQuestionScope, FlowSessionStatus } from '@thp/shared';
import { getDatabase, queryable, withTransaction, type Executor } from './client';
import {
  chapter,
  flowQuestion,
  flowSession,
  flowSessionItem,
  recording,
  series,
  tag,
} from './schema';
import { recordingWithIdIsPublished } from './visibility';

/**
 * **Every statement against the Flow Tracker's three tables** ([3.14](docs/project/prd.md);
 * [4.12](docs/project/prd.md), [4.13](docs/project/prd.md)). Query construction lives in this
 * package and nowhere else — the import-boundary guard refuses a `drizzle-orm` import outside it.
 *
 * Three groups, and the line between them is the design:
 *
 * - **Questions** are content: written by the `generate_questions` step, rewritten by an admin,
 *   read when a session is assembled. Nothing here compares a publication timestamp — a question
 *   rides the chapter or teaching it is on, and `visibility.ts` is what decided whether the member
 *   may see that.
 * - **Sessions and their items** are the member's own ([3.14.8](docs/project/prd.md)). Every read
 *   and write takes the member's id into the `where`, so "private to the member" is a property of
 *   calling anything in this group rather than of each caller remembering a condition. There is no
 *   read that takes only a session id.
 * - **Recommendations** are a read over `cross_reference` ([3.14.6](docs/project/prd.md),
 *   [3.9.8](docs/project/prd.md)): the related chapters of *other* teachings for one chapter's
 *   span. The target gate is the visibility module's fragment, as every cross-reference read's is.
 *
 * Crosses its boundary as row types in and row types out, plus an {@link Executor}, like every
 * module beside it.
 */

// =================================================================================================
// Questions
// =================================================================================================

/** One `flow_question` row. */
export interface FlowQuestionRow {
  readonly id: string;
  readonly scope: FlowQuestionScope;
  readonly chapterId: string | null;
  readonly recordingId: string | null;
  readonly tagId: string | null;
  readonly text: string;
  readonly generatedBy: unknown;
  readonly editedByAdmin: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What the step writes: a question on a chapter, or on a chapterless recording. */
export interface NewGeneratedQuestion {
  readonly scope: 'chapter' | 'recording';
  readonly chapterId?: string;
  readonly recordingId?: string;
  readonly text: string;
  /** Which model, which model version and which prompt version wrote it ([4.17.5](docs/project/prd.md)). */
  readonly generatedBy: unknown;
}

const QUESTION_COLUMNS = {
  id: flowQuestion.id,
  scope: flowQuestion.scope,
  chapterId: flowQuestion.chapterId,
  recordingId: flowQuestion.recordingId,
  tagId: flowQuestion.tagId,
  text: flowQuestion.text,
  generatedBy: flowQuestion.generatedBy,
  editedByAdmin: flowQuestion.editedByAdmin,
  createdAt: flowQuestion.createdAt,
  updatedAt: flowQuestion.updatedAt,
} as const;

/**
 * **The chapters of this teaching that have no question yet** — what the step has to write
 * ([3.14.4](docs/project/prd.md), [3.14.12](docs/project/prd.md)).
 *
 * The step fills gaps and discards nothing, so this read is the whole of what it asks: a chapter
 * with a question keeps it, whether a model or a person wrote it.
 */
export async function listChaptersMissingQuestions(
  recordingId: string,
  executor: Executor = getDatabase(),
): Promise<{ readonly id: string; readonly startMs: number; readonly title: string; readonly summary: string }[]> {
  const rows = await queryable(executor)
    .select({
      id: chapter.id,
      startMs: chapter.startMs,
      title: chapter.title,
      summary: chapter.summary,
    })
    .from(chapter)
    .leftJoin(
      flowQuestion,
      and(eq(flowQuestion.chapterId, chapter.id), eq(flowQuestion.scope, 'chapter')),
    )
    .where(and(eq(chapter.recordingId, recordingId), isNull(flowQuestion.id)))
    .orderBy(asc(chapter.startMs));
  return rows;
}

/** This teaching's whole-teaching question ([3.14.3](docs/project/prd.md)), or `null`. */
export async function findRecordingQuestion(
  recordingId: string,
  executor: Executor = getDatabase(),
): Promise<FlowQuestionRow | null> {
  const rows = await queryable(executor)
    .select(QUESTION_COLUMNS)
    .from(flowQuestion)
    .where(and(eq(flowQuestion.scope, 'recording'), eq(flowQuestion.recordingId, recordingId)))
    .limit(1);
  return (rows[0] as FlowQuestionRow | undefined) ?? null;
}

/** The questions on this teaching's chapters, keyed by chapter id. */
export async function listChapterQuestionsForRecording(
  recordingId: string,
  executor: Executor = getDatabase(),
): Promise<Map<string, FlowQuestionRow>> {
  const rows = await queryable(executor)
    .select(QUESTION_COLUMNS)
    .from(flowQuestion)
    .innerJoin(chapter, eq(chapter.id, flowQuestion.chapterId))
    .where(and(eq(flowQuestion.scope, 'chapter'), eq(chapter.recordingId, recordingId)));
  return new Map((rows as FlowQuestionRow[]).map((row) => [row.chapterId ?? '', row]));
}

/** Write what the step generated. Nothing here replaces: a duplicate is a unique violation, which fails the job. */
export async function insertGeneratedQuestions(
  questions: readonly NewGeneratedQuestion[],
  executor: Executor = getDatabase(),
): Promise<number> {
  if (questions.length === 0) return 0;
  const inserted = await queryable(executor)
    .insert(flowQuestion)
    .values(
      questions.map((one) => ({
        scope: one.scope,
        chapterId: one.chapterId ?? null,
        recordingId: one.recordingId ?? null,
        text: one.text,
        generatedBy: one.generatedBy,
        editedByAdmin: false,
      })),
    )
    .returning({ id: flowQuestion.id });
  return inserted.length;
}

/**
 * Remove the whole-teaching question. The step calls it once chapters exist: a teaching with
 * chapters is asked about each of them, not about itself as well.
 */
export async function deleteRecordingQuestion(
  recordingId: string,
  executor: Executor = getDatabase(),
): Promise<boolean> {
  const rows = await queryable(executor)
    .delete(flowQuestion)
    .where(and(eq(flowQuestion.scope, 'recording'), eq(flowQuestion.recordingId, recordingId)))
    .returning({ id: flowQuestion.id });
  return rows.length > 0;
}

/**
 * Remove the questions of these chapters, so the step writes fresh ones
 * ([3.14.12](docs/project/prd.md)). A merge calls it for the chapter that absorbed another.
 */
export async function deleteQuestionsOfChapters(
  chapterIds: readonly string[],
  executor: Executor = getDatabase(),
): Promise<number> {
  if (chapterIds.length === 0) return 0;
  const rows = await queryable(executor)
    .delete(flowQuestion)
    .where(and(eq(flowQuestion.scope, 'chapter'), inArray(flowQuestion.chapterId, chapterIds)))
    .returning({ id: flowQuestion.id });
  return rows.length;
}

/**
 * **An admin's rewrite of a chapter's question** ([3.14.11](docs/project/prd.md)).
 *
 * Update when there is one, insert when the step has not written one yet — an admin who types a
 * question before the pipeline reaches a teaching has written the question, and the step will find
 * nothing missing. `edited_by_admin` is set here rather than passed in, for the reason
 * `updateChapter` sets it: this statement exists only on the path a human takes.
 */
export async function setChapterQuestion(
  chapterId: string,
  text: string,
  executor: Executor = getDatabase(),
): Promise<FlowQuestionRow> {
  return withTransaction(async (tx) => {
    const updated = await tx
      .update(flowQuestion)
      .set({ text, editedByAdmin: true, updatedAt: new Date() })
      .where(and(eq(flowQuestion.scope, 'chapter'), eq(flowQuestion.chapterId, chapterId)))
      .returning(QUESTION_COLUMNS);
    if (updated[0] !== undefined) return updated[0] as FlowQuestionRow;

    const inserted = await tx
      .insert(flowQuestion)
      .values({ scope: 'chapter', chapterId, text, generatedBy: null, editedByAdmin: true })
      .returning(QUESTION_COLUMNS);
    const row = inserted[0] as FlowQuestionRow | undefined;
    if (!row) throw new Error('setChapterQuestion returned no row');
    return row;
  }, executor);
}

/** A tag's bank, oldest first ([3.14.11](docs/project/prd.md)). */
export async function listTagQuestions(
  tagId: string,
  executor: Executor = getDatabase(),
): Promise<FlowQuestionRow[]> {
  const rows = await queryable(executor)
    .select(QUESTION_COLUMNS)
    .from(flowQuestion)
    .where(and(eq(flowQuestion.scope, 'tag'), eq(flowQuestion.tagId, tagId)))
    .orderBy(asc(flowQuestion.createdAt), asc(flowQuestion.id));
  return rows as FlowQuestionRow[];
}

export async function insertTagQuestion(
  tagId: string,
  text: string,
  executor: Executor = getDatabase(),
): Promise<FlowQuestionRow> {
  const rows = await queryable(executor)
    .insert(flowQuestion)
    .values({ scope: 'tag', tagId, text, generatedBy: null, editedByAdmin: true })
    .returning(QUESTION_COLUMNS);
  const row = rows[0] as FlowQuestionRow | undefined;
  if (!row) throw new Error('insertTagQuestion returned no row');
  return row;
}

/** Rewrite one bank question. Both ids in the `where`, so a question cannot be edited through another tag's path. */
export async function updateTagQuestion(
  tagId: string,
  questionId: string,
  text: string,
  executor: Executor = getDatabase(),
): Promise<FlowQuestionRow | null> {
  const rows = await queryable(executor)
    .update(flowQuestion)
    .set({ text, editedByAdmin: true, updatedAt: new Date() })
    .where(
      and(
        eq(flowQuestion.id, questionId),
        eq(flowQuestion.scope, 'tag'),
        eq(flowQuestion.tagId, tagId),
      ),
    )
    .returning(QUESTION_COLUMNS);
  return (rows[0] as FlowQuestionRow | undefined) ?? null;
}

export async function deleteTagQuestion(
  tagId: string,
  questionId: string,
  executor: Executor = getDatabase(),
): Promise<boolean> {
  const rows = await queryable(executor)
    .delete(flowQuestion)
    .where(
      and(
        eq(flowQuestion.id, questionId),
        eq(flowQuestion.scope, 'tag'),
        eq(flowQuestion.tagId, tagId),
      ),
    )
    .returning({ id: flowQuestion.id });
  return rows.length > 0;
}

/**
 * **How many generated questions each teaching carries**, keyed by recording id — one per
 * chapter plus the whole-teaching one, which a teaching never has both of. The start screen's
 * count ([3.14.2](docs/project/prd.md)). A teaching with none is absent.
 */
export async function countQuestionsByRecording(
  executor: Executor = getDatabase(),
): Promise<Map<string, number>> {
  const owner = sql<string>`coalesce(${chapter.recordingId}, ${flowQuestion.recordingId})`;
  const rows = await queryable(executor)
    .select({ recordingId: owner, questions: count() })
    .from(flowQuestion)
    .leftJoin(chapter, eq(chapter.id, flowQuestion.chapterId))
    .where(inArray(flowQuestion.scope, ['chapter', 'recording']))
    .groupBy(owner);
  return new Map(rows.map((row) => [row.recordingId, Number(row.questions)]));
}

/** How many bank questions each tag carries, keyed by tag id. A tag with none is absent. */
export async function countQuestionsByTag(
  executor: Executor = getDatabase(),
): Promise<Map<string, number>> {
  const rows = await queryable(executor)
    .select({ tagId: flowQuestion.tagId, questions: count() })
    .from(flowQuestion)
    .where(eq(flowQuestion.scope, 'tag'))
    .groupBy(flowQuestion.tagId);
  return new Map(rows.map((row) => [row.tagId ?? '', Number(row.questions)]));
}

/** A question as a session is assembled from it: the text and the chapter or teaching it is on. */
export interface FlowQuestionSourceRow {
  readonly scope: 'chapter' | 'recording';
  readonly recordingId: string;
  readonly chapterId: string | null;
  readonly chapterTitle: string | null;
  readonly chapterSummary: string | null;
  readonly chapterStartMs: number | null;
  readonly text: string;
}

/**
 * **Every generated question on these teachings**, for assembling a session
 * ([3.14.3](docs/project/prd.md)). Unordered: the service orders them, because the order is a
 * product rule ([3.14.5](docs/project/prd.md)) rather than a property of the rows.
 */
export async function listQuestionsForRecordings(
  recordingIds: readonly string[],
  executor: Executor = getDatabase(),
): Promise<FlowQuestionSourceRow[]> {
  if (recordingIds.length === 0) return [];
  const owner = sql<string>`coalesce(${chapter.recordingId}, ${flowQuestion.recordingId})`;
  const rows = await queryable(executor)
    .select({
      scope: flowQuestion.scope,
      recordingId: owner,
      chapterId: flowQuestion.chapterId,
      chapterTitle: chapter.title,
      chapterSummary: chapter.summary,
      chapterStartMs: chapter.startMs,
      text: flowQuestion.text,
    })
    .from(flowQuestion)
    .leftJoin(chapter, eq(chapter.id, flowQuestion.chapterId))
    .where(and(inArray(flowQuestion.scope, ['chapter', 'recording']), inArray(owner, recordingIds)));
  return rows as FlowQuestionSourceRow[];
}

/** A bank question with the tag it belongs to, for the tag items of a session. */
export interface TagQuestionSourceRow {
  readonly tagId: string;
  readonly tagName: string;
  readonly text: string;
}

/** The banks of these tags, in the order the console shows each one. */
export async function listTagQuestionsForTags(
  tagIds: readonly string[],
  executor: Executor = getDatabase(),
): Promise<TagQuestionSourceRow[]> {
  if (tagIds.length === 0) return [];
  const rows = await queryable(executor)
    .select({ tagId: tag.id, tagName: tag.name, text: flowQuestion.text })
    .from(flowQuestion)
    .innerJoin(tag, eq(tag.id, flowQuestion.tagId))
    .where(and(eq(flowQuestion.scope, 'tag'), inArray(flowQuestion.tagId, tagIds)))
    .orderBy(asc(tag.name), asc(flowQuestion.createdAt), asc(flowQuestion.id));
  return rows;
}

// =================================================================================================
// Sessions
// =================================================================================================

/** One `flow_session` row. */
export interface FlowSessionRow {
  readonly id: string;
  readonly userId: string;
  readonly divergenceRecordingId: string;
  readonly status: FlowSessionStatus;
  readonly teachingCount: number;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  readonly abandonedAt: Date | null;
}

/** A session as the page lists it: the row, the teaching it started from, and three counts. */
export interface FlowSessionListRow extends FlowSessionRow {
  readonly divergenceTitle: string;
  /** `YYYY-MM-DD`. */
  readonly divergenceRecordedAt: string;
  readonly divergenceSeriesId: string | null;
  readonly divergenceSeriesTitle: string | null;
  readonly divergenceSeriesArtworkKey: string | null;
  /** Live items — see {@link liveItem}. */
  readonly questionCount: number;
  readonly answeredCount: number;
  readonly gapCount: number;
}

/** One question as the session is assembled with it. */
export interface NewFlowSessionItem {
  readonly kind: FlowQuestionScope;
  readonly recordingId: string | null;
  readonly chapterId: string | null;
  readonly tagId: string | null;
  readonly question: string;
  readonly title: string;
  readonly summary: string | null;
  readonly startMs: number | null;
}

export interface NewFlowSession {
  readonly userId: string;
  readonly divergenceRecordingId: string;
  readonly teachingCount: number;
  /** In the order they are asked; `position` is the index plus one. */
  readonly items: readonly NewFlowSessionItem[];
}

/** One item as the session reads it, with the teaching, the live chapter and the tag beside it. */
export interface FlowSessionItemRow {
  readonly id: string;
  readonly sessionId: string;
  readonly position: number;
  readonly kind: FlowQuestionScope;
  readonly recordingId: string | null;
  /** `null` once the chapter is gone — the item's chapter was deleted or regenerated away. */
  readonly chapterId: string | null;
  readonly tagId: string | null;
  readonly question: string;
  readonly title: string;
  readonly summary: string | null;
  readonly startMs: number | null;
  readonly answer: FlowAnswer | null;
  readonly answeredAt: Date | null;
  readonly doneAt: Date | null;
  readonly recordingTitle: string | null;
  readonly recordingRecordedAt: string | null;
  readonly seriesId: string | null;
  readonly seriesTitle: string | null;
  readonly seriesArtworkKey: string | null;
  readonly tagName: string | null;
}

const SESSION_COLUMNS = {
  id: flowSession.id,
  userId: flowSession.userId,
  divergenceRecordingId: flowSession.divergenceRecordingId,
  status: flowSession.status,
  teachingCount: flowSession.teachingCount,
  createdAt: flowSession.createdAt,
  completedAt: flowSession.completedAt,
  abandonedAt: flowSession.abandonedAt,
} as const;

/**
 * **Which items still count** ([3.14.10](docs/project/prd.md)): every answered one, and every
 * unanswered one whose chapter or tag still exists. An unanswered item pointing at a chapter that
 * has gone is dropped — there is nothing left to ask about — while an answered one keeps its place,
 * because the member's answer is theirs whatever an admin did to the chapter since.
 *
 * Spelled once as SQL and used by every read that counts or lists items, so the question screen,
 * the reading list and the page's counts agree about what a session holds.
 */
const liveItem = sql`(
  ${flowSessionItem.answer} is not null
  or (${flowSessionItem.kind} = 'chapter' and ${flowSessionItem.chapterId} is not null)
  or (${flowSessionItem.kind} = 'tag' and ${flowSessionItem.tagId} is not null)
  or ${flowSessionItem.kind} = 'recording'
)`;

const GAP_ANSWERS_SQL = sql`('dont_remember', 'recall_slightly', 'not_embodied')`;

const questionCount = sql<number>`(
  select count(*) from ${flowSessionItem}
  where ${flowSessionItem.sessionId} = ${flowSession.id} and ${liveItem}
)::int`;
const answeredCount = sql<number>`(
  select count(*) from ${flowSessionItem}
  where ${flowSessionItem.sessionId} = ${flowSession.id} and ${flowSessionItem.answer} is not null
)::int`;
const gapCount = sql<number>`(
  select count(*) from ${flowSessionItem}
  where ${flowSessionItem.sessionId} = ${flowSession.id}
    and ${flowSessionItem.answer} in ${GAP_ANSWERS_SQL}
)::int`;

/**
 * **Start a session** ([3.14.2](docs/project/prd.md), [3.14.3](docs/project/prd.md)): the row and
 * every item, in one transaction, so a session with half its questions is not a state that can be
 * read. A member with a session already in progress hits the partial unique index, which the
 * service reads as `flow_session_in_progress`.
 */
export async function insertFlowSession(
  input: NewFlowSession,
  executor: Executor = getDatabase(),
): Promise<FlowSessionRow> {
  return withTransaction(async (tx) => {
    const inserted = await tx
      .insert(flowSession)
      .values({
        userId: input.userId,
        divergenceRecordingId: input.divergenceRecordingId,
        teachingCount: input.teachingCount,
      })
      .returning(SESSION_COLUMNS);
    const row = inserted[0] as FlowSessionRow | undefined;
    if (!row) throw new Error('insertFlowSession returned no row');

    if (input.items.length > 0) {
      await tx.insert(flowSessionItem).values(
        input.items.map((one, index) => ({
          sessionId: row.id,
          position: index + 1,
          kind: one.kind,
          recordingId: one.recordingId,
          chapterId: one.chapterId,
          tagId: one.tagId,
          question: one.question,
          title: one.title,
          summary: one.summary,
          startMs: one.startMs,
        })),
      );
    }
    return row;
  }, executor);
}

function sessionList(executor: Executor) {
  return queryable(executor)
    .select({
      ...SESSION_COLUMNS,
      divergenceTitle: recording.title,
      divergenceRecordedAt: recording.recordedAt,
      divergenceSeriesId: series.id,
      divergenceSeriesTitle: series.title,
      divergenceSeriesArtworkKey: series.artworkKey,
      questionCount,
      answeredCount,
      gapCount,
    })
    .from(flowSession)
    .innerJoin(recording, eq(recording.id, flowSession.divergenceRecordingId))
    .leftJoin(series, eq(series.id, recording.seriesId));
}

/** This member's sessions, newest first ([3.14.10](docs/project/prd.md)). */
export async function listFlowSessionsForMember(
  userId: string,
  executor: Executor = getDatabase(),
): Promise<FlowSessionListRow[]> {
  const rows = await sessionList(executor)
    .where(eq(flowSession.userId, userId))
    .orderBy(desc(flowSession.createdAt), desc(flowSession.id));
  return rows as unknown as FlowSessionListRow[];
}

/** One session of this member's, or `null` — for an id that is not theirs as much as for one that is nobody's. */
export async function findFlowSessionForMember(
  sessionId: string,
  userId: string,
  executor: Executor = getDatabase(),
): Promise<FlowSessionListRow | null> {
  const rows = await sessionList(executor)
    .where(and(eq(flowSession.id, sessionId), eq(flowSession.userId, userId)))
    .limit(1);
  return (rows[0] as unknown as FlowSessionListRow | undefined) ?? null;
}

/** The one session in progress, or `null`. */
export async function findActiveFlowSessionForMember(
  userId: string,
  executor: Executor = getDatabase(),
): Promise<FlowSessionListRow | null> {
  const rows = await sessionList(executor)
    .where(and(eq(flowSession.userId, userId), eq(flowSession.status, 'in_progress')))
    .limit(1);
  return (rows[0] as unknown as FlowSessionListRow | undefined) ?? null;
}

/**
 * **A session's live items, in the order asked.** One statement with the teaching, the chapter
 * (whose presence says the chapter still exists) and the tag joined, so the screen is never N+1.
 */
export async function listFlowSessionItems(
  sessionId: string,
  executor: Executor = getDatabase(),
): Promise<FlowSessionItemRow[]> {
  const rows = await queryable(executor)
    .select({
      id: flowSessionItem.id,
      sessionId: flowSessionItem.sessionId,
      position: flowSessionItem.position,
      kind: flowSessionItem.kind,
      recordingId: flowSessionItem.recordingId,
      chapterId: flowSessionItem.chapterId,
      tagId: flowSessionItem.tagId,
      question: flowSessionItem.question,
      title: flowSessionItem.title,
      summary: flowSessionItem.summary,
      startMs: flowSessionItem.startMs,
      answer: flowSessionItem.answer,
      answeredAt: flowSessionItem.answeredAt,
      doneAt: flowSessionItem.doneAt,
      recordingTitle: recording.title,
      recordingRecordedAt: recording.recordedAt,
      seriesId: series.id,
      seriesTitle: series.title,
      seriesArtworkKey: series.artworkKey,
      tagName: tag.name,
    })
    .from(flowSessionItem)
    .leftJoin(recording, eq(recording.id, flowSessionItem.recordingId))
    .leftJoin(series, eq(series.id, recording.seriesId))
    .leftJoin(tag, eq(tag.id, flowSessionItem.tagId))
    .where(and(eq(flowSessionItem.sessionId, sessionId), liveItem))
    .orderBy(asc(flowSessionItem.position));
  return rows as FlowSessionItemRow[];
}

/**
 * **Answer one question** ([3.14.6](docs/project/prd.md)). Both ids in the `where`, so an item
 * cannot be answered through another session's path; `null` when nothing matched. Answering again
 * replaces the answer — the member stepped back to change their mind ([3.14.5](docs/project/prd.md)).
 */
export async function answerFlowSessionItem(
  sessionId: string,
  itemId: string,
  answer: FlowAnswer,
  executor: Executor = getDatabase(),
): Promise<boolean> {
  const rows = await queryable(executor)
    .update(flowSessionItem)
    .set({ answer, answeredAt: new Date() })
    .where(and(eq(flowSessionItem.id, itemId), eq(flowSessionItem.sessionId, sessionId)))
    .returning({ id: flowSessionItem.id });
  return rows.length > 0;
}

/** How many live items still have no answer — zero is what completes a session. */
export async function countUnansweredFlowItems(
  sessionId: string,
  executor: Executor = getDatabase(),
): Promise<number> {
  const rows = await queryable(executor)
    .select({ unanswered: count() })
    .from(flowSessionItem)
    .where(
      and(eq(flowSessionItem.sessionId, sessionId), isNull(flowSessionItem.answer), liveItem),
    );
  return Number(rows[0]?.unanswered ?? 0);
}

/** The session is complete ([3.14.10](docs/project/prd.md)). Only from in progress; `false` otherwise. */
export async function completeFlowSession(
  sessionId: string,
  userId: string,
  executor: Executor = getDatabase(),
): Promise<boolean> {
  const rows = await queryable(executor)
    .update(flowSession)
    .set({ status: 'complete', completedAt: new Date() })
    .where(
      and(
        eq(flowSession.id, sessionId),
        eq(flowSession.userId, userId),
        eq(flowSession.status, 'in_progress'),
      ),
    )
    .returning({ id: flowSession.id });
  return rows.length > 0;
}

/** The member gave the session up ([3.14.10](docs/project/prd.md)). Only from in progress. */
export async function abandonFlowSession(
  sessionId: string,
  userId: string,
  executor: Executor = getDatabase(),
): Promise<boolean> {
  const rows = await queryable(executor)
    .update(flowSession)
    .set({ status: 'abandoned', abandonedAt: new Date() })
    .where(
      and(
        eq(flowSession.id, sessionId),
        eq(flowSession.userId, userId),
        eq(flowSession.status, 'in_progress'),
      ),
    )
    .returning({ id: flowSession.id });
  return rows.length > 0;
}

/** Tick a reading-list row off, or un-tick it ([3.14.9](docs/project/prd.md)). */
export async function setFlowSessionItemDone(
  sessionId: string,
  itemId: string,
  done: boolean,
  executor: Executor = getDatabase(),
): Promise<boolean> {
  const rows = await queryable(executor)
    .update(flowSessionItem)
    .set({ doneAt: done ? new Date() : null })
    .where(and(eq(flowSessionItem.id, itemId), eq(flowSessionItem.sessionId, sessionId)))
    .returning({ id: flowSessionItem.id });
  return rows.length > 0;
}

// =================================================================================================
// Recommendations
// =================================================================================================

/** A related chapter of another teaching, as the reading list prints it beneath a row. */
export interface RelatedChapterRow {
  readonly recordingId: string;
  readonly recordingTitle: string;
  /** `YYYY-MM-DD`. */
  readonly recordedAt: string;
  readonly seriesId: string | null;
  readonly seriesTitle: string | null;
  readonly seriesArtworkKey: string | null;
  readonly chapterId: string;
  readonly chapterTitle: string;
  readonly chapterStartMs: number;
  readonly score: number;
}

/**
 * **The chapters of other teachings that speak to this span** ([3.14.6](docs/project/prd.md),
 * [3.9.8](docs/project/prd.md)) — strongest first, at most `limit`.
 *
 * Every link out of the span's sentences is followed to the sentence it lands on, and that
 * sentence is placed in its own teaching's chapter by the same arithmetic the chapter page uses
 * (project tdd 3.8): the chapter with the greatest start at or before the sentence's start. One
 * row per target chapter, carrying the strongest link into it. A target teaching with no chapters
 * contributes nothing, because there is no chapter to recommend. The target gate is the visibility
 * module's fragment, as every cross-reference read's is.
 *
 * The bounds are compared as `bigint`: a last chapter's span has no end, and the caller says so
 * with the largest safe integer, which an `integer` comparison would refuse.
 */
export async function listRelatedChapters(
  recordingId: string,
  startMs: number,
  endMs: number,
  limit: number,
  executor: Executor = getDatabase(),
): Promise<RelatedChapterRow[]> {
  const rows = await queryable(executor).execute(sql`
    with hits as (
      select distinct on (tc.id)
        tc.id as chapter_id,
        tc.title as chapter_title,
        tc.start_ms as chapter_start_ms,
        x.target_recording_id as recording_id,
        x.score
      from cross_reference as x
      join segment as src on src.id = x.source_segment_id
      join segment as tgt on tgt.id = x.target_segment_id
      join chapter as tc
        on tc.recording_id = x.target_recording_id
       and tc.start_ms <= tgt.start_ms
       and not exists (
         select 1 from chapter as nearer
         where nearer.recording_id = tc.recording_id
           and nearer.start_ms <= tgt.start_ms
           and nearer.start_ms > tc.start_ms
       )
      where x.source_recording_id = ${recordingId}
        and src.start_ms >= ${startMs}::bigint
        and src.start_ms < ${endMs}::bigint
        and ${recordingWithIdIsPublished(sql`x.target_recording_id`)}
      order by tc.id, x.score desc
    )
    select
      h.recording_id as "recordingId",
      r.title as "recordingTitle",
      r.recorded_at as "recordedAt",
      s.id as "seriesId",
      s.title as "seriesTitle",
      s.artwork_key as "seriesArtworkKey",
      h.chapter_id as "chapterId",
      h.chapter_title as "chapterTitle",
      h.chapter_start_ms as "chapterStartMs",
      h.score
    from hits as h
    join recording as r on r.id = h.recording_id
    left join series as s on s.id = r.series_id
    order by h.score desc, h.chapter_id asc
    limit ${limit}
  `);
  return (rows as unknown as RelatedChapterRow[]).map((row) => ({
    ...row,
    recordedAt: String(row.recordedAt).slice(0, 10),
    score: Number(row.score),
  }));
}
