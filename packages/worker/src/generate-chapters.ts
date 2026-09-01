import {
  findRecordingById,
  findTranscriptByRecording,
  listSegments,
  replaceChapters,
  type Executor,
  type JobRow,
  type NewChapter,
  type ProviderMeta,
} from '@thp/db';
import { emitDomainEvent } from '@thp/shared/observability/events';
import { logger } from '@thp/shared/observability/logger';
import { settleChapters } from './chapters/boundaries';
import { generator as configuredGenerator, type Generator, type TranscriptLine } from './generate';
import type { JobHandler } from './handlers';

/**
 * **The `generate_chapters` step** ([3.22.1](docs/project/prd.md)) — the third and last step of the
 * chain, and the first one whose output a member reads without an admin approving it.
 *
 * Four properties, and every one of them is a requirement rather than a preference:
 *
 * 1. **It writes the whole list or none of it** ([3.22.9](docs/project/prd.md)). The tiling is the
 *    artefact and half of one is not a smaller artefact, so `replaceChapters` is one transaction and
 *    every refusal happens before it opens. A failed or interrupted run flags the recording
 *    ([3.21.2.3](docs/project/prd.md), [3.21.2.6](docs/project/prd.md)) and changes nothing a
 *    member can see — including on a **published** recording, which is the case that matters.
 * 2. **What it writes is member-visible the moment the recording is**
 *    ([3.22.6](docs/project/prd.md)). No `review_item`, no status column, no second gate: a chapter
 *    cannot be published or withdrawn independently of the teaching it divides, so the recording's
 *    own publication is the gate it passes. That is the one place this scope steps outside the
 *    review gate, and it is paid for in one place instead — re-running this step on a live
 *    recording is confirmed rather than silent ([3.22.8](docs/project/prd.md)), which the admin
 *    console owns.
 * 3. **Running it twice leaves one list.** Dispatch is at-least-once, so the write replaces rather
 *    than appends — and because there is no `end_ms` to keep in step, replacing cannot leave a gap
 *    behind (project tdd 3.7).
 * 4. **A recording with no transcript fails the job**, naming that. Chapters are cut from the
 *    transcript ([3.22.1](docs/project/prd.md)) and their boundaries have to land on its segments
 *    ([3.22.5](docs/project/prd.md)), so generating from nothing is not a shorter version of this
 *    step — it is a different one, and it would produce boundaries into silence.
 *
 * **An empty list is a success.** A teaching too short to hold two chapters gets none
 * ([3.22.4](docs/project/prd.md)), and a step that failed over the ordinary case would put a red
 * row on `/admin/pipeline` for every short teaching in the back catalogue.
 */

export interface GenerateChaptersDependencies {
  readonly generator?: Generator;
  /** Where the chapters are written. Defaults to the process's pool. */
  readonly executor?: Executor;
}

/**
 * Build the handler.
 *
 * A factory rather than a function, so a test supplies a fake generator the same way the loop is
 * given a handler registry — and so nothing reads the environment until a job actually arrives.
 */
export function createGenerateChaptersHandler(
  deps: GenerateChaptersDependencies = {},
): JobHandler {
  return async function generateChapters(job: JobRow): Promise<ProviderMeta> {
    const model = deps.generator ?? configuredGenerator();
    const fields = { jobId: job.id, recordingId: job.recordingId };

    logger.info('generate_chapters.started', fields);

    const recording = await findRecordingById(job.recordingId, deps.executor);
    if (!recording) throw fail(fields, `no recording ${job.recordingId}`);

    const transcript = await findTranscriptByRecording(job.recordingId, deps.executor);
    if (!transcript) {
      // Asked before the provider is, so a recording with nothing to divide fails naming that
      // rather than spending a call on an empty prompt.
      throw fail(fields, `recording ${job.recordingId} has no transcript to cut into chapters`);
    }

    const segments = await listSegments(transcript.id, deps.executor);
    if (segments.length === 0) {
      throw fail(fields, `the transcript for recording ${job.recordingId} has no segments in it`);
    }

    const lines: TranscriptLine[] = segments.map((one) => ({
      startMs: one.startMs,
      text: one.text,
    }));

    /*
     * **How long the teaching runs, as far as the product knows** ([4.2](docs/project/prd.md)).
     *
     * The end of the last segment. Read off the rows already in hand rather than through
     * `findTranscriptEndMs`, which exists for the API's read path — asking the database for a number
     * this loop already has would be a round trip for arithmetic.
     */
    const durationMs = segments.reduce((longest, one) => Math.max(longest, one.endMs), 0);

    let result;
    try {
      result = await model.segmentChapters({ title: recording.title, lines, durationMs });
    } catch (cause) {
      throw fail(fields, cause instanceof Error ? cause.message : String(cause), cause);
    }

    /*
     * Every rule about where a boundary may be, applied in one call — and applied **before** the
     * transaction opens, so a list that settles to nothing is a write of nothing rather than a
     * partial write of something.
     */
    const settled = settleChapters(result.chapters, lines);

    /**
     * [4.19](docs/project/prd.md)'s *Generated by* — which model, which model version and which
     * prompt version produced the list ([4.17.5](docs/project/prd.md)).
     *
     * One value for the whole list, because one call produced every boundary in it.
     */
    const generatedBy = {
      model: result.spend.model,
      modelVersion: result.spend.modelVersion,
      promptVersion: result.promptVersion,
    };

    const chapters: NewChapter[] = settled.chapters.map((one) => ({
      startMs: one.startMs,
      title: one.title,
      summary: one.summary,
      // Nothing this step writes has been touched by a person; the edit path is what sets it.
      editedByAdmin: false,
    }));

    await replaceChapters(job.recordingId, chapters, generatedBy, deps.executor);

    const providerMeta: ProviderMeta = {
      ...generatedBy,
      inputTokens: result.spend.inputTokens,
      outputTokens: result.spend.outputTokens,
      costUsd: result.spend.costUsd,
      requestId: result.spend.requestId,
      // What the run produced and what it had to repair, on the job that caused it — the same shape
      // `generate_draft` records its dropped citations in, and for the same reason: a prompt going
      // wrong should be visible rather than quiet.
      chaptersProposed: result.chapters.length,
      chaptersWritten: chapters.length,
      chaptersSnapped: settled.snapped,
      chaptersDuplicated: settled.duplicates,
      chaptersTooSoon: settled.tooSoon,
    };

    logger.info('generate_chapters.succeeded', {
      ...fields,
      provider: model.name,
      durationMs,
      ...providerMeta,
    });

    if (settled.tooFew) {
      /*
       * Its own line, at info rather than warn: a teaching too short to divide is
       * [3.22.4](docs/project/prd.md) working, not a defect. It is logged at all because "this
       * teaching has no chapters" and "chapter generation has not run" look identical from the
       * outside, and an operator asking which one they are looking at deserves an answer.
       */
      logger.info('generate_chapters.too_few', { ...fields, durationMs });
    }

    if (settled.snapped > 0 || settled.duplicates > 0 || settled.tooSoon > 0) {
      // At warn, because it is the one thing about a *successful* run somebody should look at: the
      // step worked and part of what the model proposed was not usable as it stood.
      logger.warn('generate_chapters.boundaries_repaired', {
        ...fields,
        snapped: settled.snapped,
        duplicates: settled.duplicates,
        tooSoon: settled.tooSoon,
      });
    }

    // Nothing subscribes. §3.17's notifications are what will — see the events module.
    emitDomainEvent({ type: 'chapters_generated', recordingId: job.recordingId });

    return providerMeta;
  };
}

/** Log the failure with the whole of it, and hand back the sentence the job row will carry. */
function fail(fields: Record<string, unknown>, reason: string, cause?: unknown): Error {
  logger.error('generate_chapters.failed', {
    ...fields,
    reason,
    ...(cause instanceof Error ? { error: cause.stack ?? cause.message } : {}),
  });
  return new Error(reason);
}
