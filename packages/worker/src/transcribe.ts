import {
  findRecordingById,
  replaceTranscript,
  type Executor,
  type JobRow,
  type ProviderMeta,
} from '@thp/db';
import { mediaStore, type MediaStore } from '@thp/media';
import { logger } from '@thp/shared/observability/logger';
import { transcriber as configuredTranscriber, type Transcriber } from './asr';
import type { JobHandler } from './handlers';

/**
 * **The `transcribe` step, doing the work the stub stood in for.**
 *
 * Read the original, hand the provider a signed URL to it, write the transcript and its segments,
 * and record what the job cost ([3.5.1](docs/project/prd.md), [3.5.2](docs/project/prd.md),
 * [§7](docs/project/prd.md)). Four properties are worth naming before the code:
 *
 * 1. **The bytes never come here.** The provider fetches the object from a short-lived signed `GET`,
 *    which is the same boundary the presigned `PUT` holds on the way in.
 * 2. **Running it twice leaves one transcript.** Dispatch is at-least-once — the startup sweep and
 *    Ticket 04's re-run both call this again on the same recording — so the write is a replace, and
 *    `replaceTranscript` is what makes that one transaction rather than a delete somebody hopes
 *    committed. The cost, stated rather than defended against: a re-run discards any corrections
 *    Story 5 will let an admin make.
 * 3. **The original is never touched.** Nothing here writes to the store; there is nothing on the
 *    port to write with but a `PUT` grant this never mints ([3.4.9](docs/project/prd.md)).
 * 4. **Low confidence writes the transcript and then fails the job** — see {@link isConfident}.
 */

/**
 * English, pinned rather than detected ([3.5.7](docs/project/prd.md)).
 *
 * The ministry publishes in English, the monolingual model is the more accurate one and the one the
 * cost table is built on, and detection would buy nothing. `transcript.language` is still written
 * and still reads this, which is what keeps [4.4](docs/project/prd.md)'s Language field honest and
 * makes a second language an adapter change rather than a back-fill over every transcript already
 * written.
 *
 * **The accepted cost:** a recording in another language is transcribed badly as English and still
 * reads `en` — a wrong answer rather than a visible one. The confidence gate is the only thing
 * likely to catch it.
 */
export const TRANSCRIPTION_LANGUAGE = 'en';

/**
 * Two hours. Long enough for the provider to fetch and process a 200 MB file, short enough that a
 * URL that leaked is not a standing grant to somebody's teaching.
 *
 * The trade taken knowingly: a signed URL to a bucket that is never publicly readable is briefly
 * held by a third party. The alternative is streaming 200 MB through this process, twice.
 */
export const TRANSCRIPTION_GRANT_SECONDS = 2 * 60 * 60;

/**
 * **The confidence gate** ([3.5.8](docs/project/prd.md)).
 *
 * 0.6 is a first setting, not a measured one; the first real recording is what tells us whether it
 * is right. One named constant rather than a literal at the comparison, so moving it is one edit
 * and reading it is one place.
 */
export const CONFIDENCE_THRESHOLD = 0.6;

/** Whether a transcript is good enough to generate from. At the threshold counts as confident. */
export function isConfident(confidence: number): boolean {
  return confidence >= CONFIDENCE_THRESHOLD;
}

export interface TranscribeDependencies {
  readonly transcriber?: Transcriber;
  readonly media?: MediaStore;
  /** Where the transcript is written. Defaults to the process's pool. */
  readonly executor?: Executor;
}

/**
 * Build the handler.
 *
 * A factory rather than a function, so a test supplies a fake transcriber and a media store the
 * same way the loop is given a handler registry — and so nothing reads the environment until a job
 * actually arrives.
 */
export function createTranscribeHandler(deps: TranscribeDependencies = {}): JobHandler {
  return async function transcribe(job: JobRow): Promise<ProviderMeta> {
    const media = deps.media ?? mediaStore();
    const asr = deps.transcriber ?? configuredTranscriber();
    const fields = { jobId: job.id, recordingId: job.recordingId };

    logger.info('transcribe.started', fields);

    const recording = await findRecordingById(job.recordingId, deps.executor);
    if (!recording) throw fail(fields, `no recording ${job.recordingId}`);

    const key = recording.originalMediaKey;

    // Asked before the provider is, so a recording pointing at nothing fails naming the key rather
    // than as a fetch error inside somebody else's service.
    if ((await media.head(key)) === null) throw fail(fields, `no object at key "${key}"`);

    const audioUrl = await media.presignGet({
      key,
      expiresInSeconds: TRANSCRIPTION_GRANT_SECONDS,
    });

    let result;
    try {
      result = await asr.transcribe({ audioUrl, language: TRANSCRIPTION_LANGUAGE });
    } catch (cause) {
      throw fail(fields, cause instanceof Error ? cause.message : String(cause), cause);
    }

    if (result.segments.length === 0) {
      // Silence is a recording nobody wants a summary of, and an empty transcript would chain
      // forward looking exactly like a successful one.
      throw fail(fields, `${asr.name} returned no segments for "${key}"`);
    }

    await replaceTranscript(
      {
        recordingId: job.recordingId,
        language: result.language,
        confidence: result.confidence,
        segments: result.segments.map((one) => ({
          startMs: one.startMs,
          endMs: one.endMs,
          text: one.text.trim(),
        })),
      },
      deps.executor,
    );

    const providerMeta: ProviderMeta = {
      model: result.spend.model,
      modelVersion: result.spend.modelVersion,
      durationSeconds: result.spend.durationSeconds,
      costUsd: result.spend.costUsd,
      requestId: result.spend.requestId,
    };

    const measured = {
      ...fields,
      provider: asr.name,
      // The provider's own id for the call, which is what completes the API request → job →
      // provider call span docs/epics/epic-core-listening/architecture.md § Key choices asks for.
      // The correlation id is on every line already; the runner bound it before calling this.
      requestId: result.spend.requestId,
      language: result.language,
      confidence: result.confidence,
      segments: result.segments.length,
      ...providerMeta,
    };

    if (!isConfident(result.confidence)) {
      // **Written, then failed.** The admin has to be able to read the transcript to judge it, and
      // Story 5's correction has nothing to correct otherwise — but nothing is generated from it,
      // which is the whole of "rather than proceeding to downstream generation on bad input". The
      // escape hatch is Ticket 04's per-step re-run of `generate_draft`.
      logger.warn('transcribe.low_confidence', { ...measured, threshold: CONFIDENCE_THRESHOLD });
      throw new Error(
        `the transcript was written, but its confidence of ${result.confidence} is below the ` +
          `threshold of ${CONFIDENCE_THRESHOLD}; nothing was generated from it`,
      );
    }

    logger.info('transcribe.succeeded', measured);
    return providerMeta;
  };
}

/** Log the failure with the whole of it, and hand back the sentence the job row will carry. */
function fail(
  fields: Record<string, unknown>,
  reason: string,
  cause?: unknown,
): Error {
  logger.error('transcribe.failed', {
    ...fields,
    reason,
    ...(cause instanceof Error ? { error: cause.stack ?? cause.message } : {}),
  });
  return new Error(reason);
}
