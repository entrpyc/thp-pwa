import {
  findRecordingById,
  setRecordingPlaybackKey,
  type Executor,
  type JobRow,
  type ProviderMeta,
} from '@thp/db';
import { mediaStore, mintPlaybackKey, type MediaStore } from '@thp/media';
import { logger } from '@thp/shared/observability/logger';
import { audioProcessor as configuredProcessor, type AudioProcessor } from './audio';
import type { JobHandler } from './handlers';

/**
 * **The `process_audio` step** — the first in the chain, in the slot
 * [§3.4](docs/project/prd.md) reserved for it.
 *
 * It turns the uploaded original into a playback rendition browsers can seek exactly, and points
 * the recording at it. The step exists because a VBR MP3's `currentTime` after a seek is an
 * estimate — measured up to nine seconds wrong on a real teaching — and everything anchored to the
 * clock (captions, notes, chapters) inherited the error while the transcript's own timings were
 * right to within a frame.
 *
 * The transcribe handler's four properties, inherited whole:
 *
 * 1. **The bytes never sit in a queue.** The processor fetches the original off a signed `GET` and
 *    puts the rendition behind a signed `PUT`; this process brokers grants, not audio.
 * 2. **Running it twice leaves one rendition.** A re-run writes a new object under a new key and
 *    repoints the row; the superseded object stays, unreferenced — replaced artwork's price.
 * 3. **The original is never touched.** It is what the transcript's timings describe, and the
 *    `transcribe` step behind this one still reads it.
 * 4. **The upload is verified before the row is pointed at it** — a rendition the store cannot
 *    `head` is a failure here, not a silent 404 in somebody's player next Sunday.
 *
 * The work itself is {@link producePlaybackRendition}, and it is exported deliberately: the
 * backfill CLI runs it **outside the job ledger**, because a succeeded job enqueues its successor
 * and a backfill that chained into `transcribe` would replace every transcript — and its
 * corrections — in the library.
 */

/**
 * Two hours, the transcription grant's reasoning re-used: long enough to move a 200 MB file each
 * way, short enough that a leaked URL is not a standing grant to somebody's teaching.
 */
export const PROCESS_AUDIO_GRANT_SECONDS = 2 * 60 * 60;

export interface ProcessAudioDependencies {
  readonly processor?: AudioProcessor;
  readonly media?: MediaStore;
  /** Where the recording row is written. Defaults to the process's pool. */
  readonly executor?: Executor;
}

/** What producing a rendition leaves behind — the job's evidence, and the CLI's report line. */
export interface RenditionResult {
  readonly tool: string;
  readonly renditionKey: string;
  readonly renditionBytes: number;
  readonly sourceBytes: number;
}

/**
 * Produce the playback rendition for one recording and point the row at it.
 *
 * Failure is a throw carrying a sentence an operator can read — off the failed job row when the
 * handler called, off the console when the backfill did.
 */
export async function producePlaybackRendition(
  recordingId: string,
  deps: ProcessAudioDependencies = {},
): Promise<RenditionResult> {
  const media = deps.media ?? mediaStore();
  const processor = deps.processor ?? configuredProcessor();

  const recording = await findRecordingById(recordingId, deps.executor);
  if (!recording) throw new Error(`no recording ${recordingId}`);

  const sourceKey = recording.originalMediaKey;
  const source = await media.head(sourceKey);
  if (source === null) throw new Error(`no object at key "${sourceKey}"`);

  const rendition = processor.outputFor(extensionOf(sourceKey), source.contentType);
  const renditionKey = mintPlaybackKey(rendition.extension);

  const sourceUrl = await media.presignGet({
    key: sourceKey,
    expiresInSeconds: PROCESS_AUDIO_GRANT_SECONDS,
  });
  const uploadUrl = await media.presignPut({
    key: renditionKey,
    contentType: rendition.contentType,
    expiresInSeconds: PROCESS_AUDIO_GRANT_SECONDS,
  });

  await processor.process({ sourceUrl, uploadUrl, contentType: rendition.contentType });

  // Property 4: the row points only at an object the store confirms is there.
  const stored = await media.head(renditionKey);
  if (stored === null) {
    throw new Error(`${processor.name} reported success but nothing is at "${renditionKey}"`);
  }

  const updated = await setRecordingPlaybackKey(recordingId, renditionKey, deps.executor);
  if (updated === null) throw new Error(`no recording ${recordingId} to point at the rendition`);

  return {
    tool: processor.name,
    renditionKey,
    renditionBytes: stored.size,
    sourceBytes: source.size,
  };
}

/**
 * Build the handler. A factory for the transcribe handler's reasons: a test supplies a fake
 * processor and store, and nothing reads the environment until a job actually arrives.
 */
export function createProcessAudioHandler(deps: ProcessAudioDependencies = {}): JobHandler {
  return async function processAudio(job: JobRow): Promise<ProviderMeta> {
    const fields = { jobId: job.id, recordingId: job.recordingId };
    logger.info('process_audio.started', fields);

    let result: RenditionResult;
    try {
      result = await producePlaybackRendition(job.recordingId, deps);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      logger.error('process_audio.failed', {
        ...fields,
        reason,
        ...(cause instanceof Error ? { error: cause.stack ?? cause.message } : {}),
      });
      throw new Error(reason);
    }

    // Evidence, not spend: the tool is local and costs nothing, but which adapter produced which
    // object at what size is what an operator reads when a rendition sounds wrong.
    const providerMeta: ProviderMeta = { ...result, costUsd: 0 };
    logger.info('process_audio.succeeded', { ...fields, ...providerMeta });
    return providerMeta;
  };
}

/** The extension the key carries, or `bin` for a key with none; the fake echoes it back. */
function extensionOf(key: string): string {
  const at = key.lastIndexOf('.');
  return at < 0 ? 'bin' : key.slice(at + 1);
}
