import {
  deleteRecordingQuestion,
  findRecordingById,
  findRecordingQuestion,
  findSummaryByRecording,
  findTranscriptByRecording,
  insertGeneratedQuestions,
  listChapters,
  listChaptersMissingQuestions,
  listSegments,
  withTransaction,
  type Executor,
  type JobRow,
  type NewGeneratedQuestion,
  type ProviderMeta,
} from '@thp/db';
import { MAX_FLOW_QUESTION_LENGTH } from '@thp/shared';
import { emitDomainEvent } from '@thp/shared/observability/events';
import { logger } from '@thp/shared/observability/logger';
import {
  generator as configuredGenerator,
  type Generator,
  type ReflectionSubject,
} from './generate';
import type { JobHandler } from './handlers';
import { withSpend } from './paid-failure';

/**
 * **The `generate_questions` step** ([3.14.4](docs/project/prd.md)) — one self-reflection
 * question for every chapter the step before it wrote, or one for the whole teaching when it was
 * too short to hold chapters ([3.22.4](docs/project/prd.md), [3.14.3](docs/project/prd.md)).
 *
 * Four properties, each a requirement:
 *
 * 1. **It fills gaps and discards nothing** ([3.14.12](docs/project/prd.md)). A chapter that has a
 *    question keeps it, whether a model or an admin wrote it. That is what makes the step safe to
 *    re-run without a confirming press, and what lets a split or a merge enqueue it to write the
 *    one question the edit left missing rather than every question on the teaching. Regeneration
 *    of the chapter list is a different matter: the chapters cascade their questions away, and
 *    this step then finds every one missing — which is 3.14.12's "questions follow their
 *    chapters", paid for in the key rather than here.
 * 2. **What it writes is member-visible the moment the recording is** ([3.22.6](docs/project/prd.md)
 *    as 3.14.4 cites it). No review item and no status column, for the reason chapters have none.
 * 3. **Running it twice leaves one question per chapter.** The second run finds nothing missing,
 *    spends nothing, and succeeds — dispatch is at-least-once and a handler that could not survive
 *    running twice is a bug.
 * 4. **A chapterless teaching gets one question from its summary** — the admin-approved one when
 *    there is one, the draft otherwise, and the opening of the transcript when there is neither.
 *    A teaching with chapters has its whole-teaching question removed: it is asked about each
 *    chapter, not about itself as well.
 *
 * **Nothing to write is a success**, logged at info: a teaching with every question in place is
 * the ordinary state after an edit that touched no chapter, and a red row for it would be noise.
 */

/** How much of the transcript stands in for a summary when a short teaching has none. */
const TRANSCRIPT_EXCERPT_CHARS = 3_000;

/** The key a whole-teaching subject is sent under; a chapter's key is its id. */
const WHOLE_TEACHING_KEY = 'teaching';

export interface GenerateQuestionsDependencies {
  readonly generator?: Generator;
  /** Where the questions are written. Defaults to the process's pool. */
  readonly executor?: Executor;
}

export function createGenerateQuestionsHandler(
  deps: GenerateQuestionsDependencies = {},
): JobHandler {
  return async function generateQuestions(job: JobRow): Promise<ProviderMeta | void> {
    const fields = { jobId: job.id, recordingId: job.recordingId };
    logger.info('generate_questions.started', fields);

    const recording = await findRecordingById(job.recordingId, deps.executor);
    if (!recording) throw fail(fields, `no recording ${job.recordingId}`);

    const chapters = await listChapters(job.recordingId, deps.executor);

    /*
     * What is missing, and therefore what to ask for. Read before the provider is, so a teaching
     * with nothing missing costs nothing — and so the write below can be "insert these" rather
     * than "replace everything", which is the whole of property 1.
     */
    const subjects: ReflectionSubject[] = [];
    let wholeTeaching = false;

    if (chapters.length > 0) {
      const missing = await listChaptersMissingQuestions(job.recordingId, deps.executor);
      for (const one of missing) {
        subjects.push({ key: one.id, title: one.title, summary: one.summary });
      }
    } else if ((await findRecordingQuestion(job.recordingId, deps.executor)) === null) {
      const about = await describeWholeTeaching(job.recordingId, deps.executor);
      if (about === null) {
        throw fail(
          fields,
          `recording ${job.recordingId} has no chapters, no summary and no transcript to write a question from`,
        );
      }
      subjects.push({ key: WHOLE_TEACHING_KEY, title: recording.title, summary: about });
      wholeTeaching = true;
    }

    if (subjects.length === 0) {
      // A teaching with chapters may still carry the whole-teaching question it was given before
      // the chapters arrived; it is removed here, on the run that found nothing else to do.
      const removedStale =
        chapters.length > 0 && (await deleteRecordingQuestion(job.recordingId, deps.executor));
      logger.info('generate_questions.nothing_missing', { ...fields, removedStale });
      return;
    }

    const model = deps.generator ?? configuredGenerator();
    let result;
    try {
      result = await model.writeReflections({ title: recording.title, subjects });
    } catch (cause) {
      throw fail(fields, cause instanceof Error ? cause.message : String(cause), cause);
    }

    /*
     * Place each answer by its key. A subject the model skipped fails the job naming it, because a
     * chapter with no question is a chapter the Flow Tracker silently leaves out
     * ([3.14.3](docs/project/prd.md)) — and a quiet omission is exactly what an operator cannot
     * see from the pipeline screen. Over-long answers are cut to the ceiling rather than refused:
     * the model being verbose is not the model failing to answer.
     */
    const answered = new Map(result.reflections.map((one) => [one.key, one.question]));
    const generatedBy = {
      model: result.spend.model,
      modelVersion: result.spend.modelVersion,
      promptVersion: result.promptVersion,
    };
    // **From here on the call has been paid for.** A subject the model skipped or a write that
    // fails carries this, so the failed row counts in the day's ledger (paid-failure.ts).
    const billed: ProviderMeta = {
      provider: model.name,
      ...generatedBy,
      inputTokens: result.spend.inputTokens,
      outputTokens: result.spend.outputTokens,
      costUsd: result.spend.costUsd,
      requestId: result.spend.requestId,
    };
    const questions: NewGeneratedQuestion[] = [];
    const unanswered: string[] = [];
    for (const subject of subjects) {
      const text = answered.get(subject.key);
      if (text === undefined) {
        unanswered.push(subject.title);
        continue;
      }
      questions.push(
        subject.key === WHOLE_TEACHING_KEY
          ? { scope: 'recording', recordingId: job.recordingId, text: clip(text), generatedBy }
          : { scope: 'chapter', chapterId: subject.key, text: clip(text), generatedBy },
      );
    }
    if (unanswered.length > 0) {
      throw withSpend(
        fail(
          fields,
          `the model wrote no question for ${unanswered.length === 1 ? 'the chapter' : 'the chapters'} ${unanswered.map((one) => `“${one}”`).join(', ')}`,
        ),
        billed,
      );
    }

    let written: number;
    try {
      written = await withTransaction(async (tx) => {
        if (!wholeTeaching) await deleteRecordingQuestion(job.recordingId, tx);
        return insertGeneratedQuestions(questions, tx);
      }, deps.executor);
    } catch (cause) {
      throw withSpend(cause, billed);
    }

    const providerMeta: ProviderMeta = {
      ...billed,
      questionsAsked: subjects.length,
      questionsWritten: written,
      wholeTeaching,
    };

    logger.info('generate_questions.succeeded', { ...fields, provider: model.name, ...providerMeta });
    emitDomainEvent({ type: 'questions_generated', recordingId: job.recordingId, written });

    return providerMeta;
  };
}

/**
 * What a chapterless teaching is about, for the one question it gets: the summary when there is
 * one, the opening of the transcript otherwise, `null` when there is neither.
 */
async function describeWholeTeaching(
  recordingId: string,
  executor: Executor | undefined,
): Promise<string | null> {
  const summary = await findSummaryByRecording(recordingId, executor);
  if (summary !== null && summary.content.trim() !== '') return summary.content.trim();

  const transcript = await findTranscriptByRecording(recordingId, executor);
  if (transcript === null) return null;
  const segments = await listSegments(transcript.id, executor);
  const text = segments.map((one) => one.text).join(' ').trim();
  if (text === '') return null;
  return text.slice(0, TRANSCRIPT_EXCERPT_CHARS);
}

function clip(text: string): string {
  return text.length <= MAX_FLOW_QUESTION_LENGTH ? text : text.slice(0, MAX_FLOW_QUESTION_LENGTH).trimEnd();
}

/** Log the failure with the whole of it, and hand back the sentence the job row will carry. */
function fail(fields: Record<string, unknown>, reason: string, cause?: unknown): Error {
  logger.error('generate_questions.failed', {
    ...fields,
    reason,
    ...(cause instanceof Error ? { error: cause.stack ?? cause.message } : {}),
  });
  return new Error(reason);
}
