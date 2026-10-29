import {
  deleteTagQuestion,
  findChapterById,
  findTagById,
  insertTagQuestion,
  listTagQuestions,
  setChapterQuestion,
  updateTagQuestion,
  type FlowQuestionRow,
} from '@thp/db';
import {
  MAX_FLOW_QUESTION_LENGTH,
  type ChapterQuestionPayload,
  type TagQuestionView,
  type TagQuestionsPayload,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';

/**
 * **Curating Flow Tracker questions** ([3.14.11](docs/project/prd.md), [3.19.7](docs/project/prd.md))
 * — the admin's half of the feature, in two places that mirror where the questions live.
 *
 * - **The question on a chapter** is rewritten in place. The chapter keeps it through later runs of
 *   the step, which fills gaps and never replaces ([3.14.12](docs/project/prd.md)); only a
 *   regeneration of the chapter list takes it, and the console confirms that first.
 * - **A tag's bank** is a list an admin adds to, rewrites and removes from. A session asks each
 *   question in it once when its range carries the tag ([3.14.3](docs/project/prd.md)).
 *
 * Who may is the policy module's answer, asked by the routes. What this module decides is what a
 * question may be: not blank, and under the ceiling.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The question's text as the body sent it, or the refusal. */
function parseText(body: unknown): string {
  const raw = (body as { text?: unknown } | null)?.text;
  if (typeof raw !== 'string') throw ApiError.invalidInput('text must be the question to ask.');
  const text = raw.trim();
  if (text === '') throw ApiError.invalidInput('A question cannot be blank.');
  if (text.length > MAX_FLOW_QUESTION_LENGTH) {
    throw ApiError.invalidInput(`A question is at most ${MAX_FLOW_QUESTION_LENGTH} characters.`);
  }
  return text;
}

function parseId(value: string, message: string): string {
  const trimmed = value.trim();
  if (!UUID.test(trimmed)) throw ApiError.invalidInput(message);
  return trimmed.toLowerCase();
}

/** Rewrite the question on this chapter ([3.14.11](docs/project/prd.md)). */
export async function setChapterQuestionFor(
  actor: Actor,
  chapterId: string,
  body: unknown,
): Promise<ChapterQuestionPayload> {
  const id = parseId(chapterId, 'That is not a chapter id.');
  const text = parseText(body);

  const chapter = await findChapterById(id);
  if (chapter === null) throw ApiError.notFound('There is no such chapter.');

  const row = await setChapterQuestion(id, text);
  logger.info('flow.question.edit', {
    actorId: actor.id,
    action: 'flow.question.edit',
    target: `chapter:${id}`,
    recordingId: chapter.recordingId,
  });
  return { chapterId: id, question: row.text };
}

export async function listTagQuestionsFor(actor: Actor, tagId: string): Promise<TagQuestionsPayload> {
  const id = parseId(tagId, 'That is not a tag id.');
  await requireTag(id);
  logger.info('flow.bank.read', { actorId: actor.id, action: 'flow.bank.manage', target: `tag:${id}` });
  return { questions: (await listTagQuestions(id)).map(describe) };
}

export async function addTagQuestionFor(
  actor: Actor,
  tagId: string,
  body: unknown,
): Promise<TagQuestionsPayload> {
  const id = parseId(tagId, 'That is not a tag id.');
  const text = parseText(body);
  await requireTag(id);
  const row = await insertTagQuestion(id, text);
  logger.info('flow.bank.add', {
    actorId: actor.id,
    action: 'flow.bank.manage',
    target: `tag:${id}`,
    questionId: row.id,
  });
  return { questions: (await listTagQuestions(id)).map(describe) };
}

export async function editTagQuestionFor(
  actor: Actor,
  tagId: string,
  questionId: string,
  body: unknown,
): Promise<TagQuestionsPayload> {
  const id = parseId(tagId, 'That is not a tag id.');
  const question = parseId(questionId, 'That is not a question id.');
  const text = parseText(body);
  await requireTag(id);
  if ((await updateTagQuestion(id, question, text)) === null) {
    throw ApiError.notFound('There is no such question on this tag.');
  }
  logger.info('flow.bank.edit', {
    actorId: actor.id,
    action: 'flow.bank.manage',
    target: `tag:${id}`,
    questionId: question,
  });
  return { questions: (await listTagQuestions(id)).map(describe) };
}

/** Remove a bank question. Removing one already gone is an end state the admin is in; it answers the list. */
export async function removeTagQuestionFor(
  actor: Actor,
  tagId: string,
  questionId: string,
): Promise<TagQuestionsPayload> {
  const id = parseId(tagId, 'That is not a tag id.');
  const question = parseId(questionId, 'That is not a question id.');
  await requireTag(id);
  const removed = await deleteTagQuestion(id, question);
  logger.info('flow.bank.remove', {
    actorId: actor.id,
    action: 'flow.bank.manage',
    target: `tag:${id}`,
    questionId: question,
    removed,
  });
  return { questions: (await listTagQuestions(id)).map(describe) };
}

async function requireTag(id: string): Promise<void> {
  if ((await findTagById(id)) === null) throw ApiError.notFound('There is no such tag.');
}

function describe(row: FlowQuestionRow): TagQuestionView {
  return { id: row.id, text: row.text, createdAt: row.createdAt.toISOString() };
}
