/**
 * **What an audio processor is, as far as the `process_audio` step is concerned.**
 *
 * The step's job is one sentence: turn the uploaded original into a rendition browsers can seek
 * exactly, and put it in the store. The port carries that sentence and nothing vendor- or
 * tool-shaped: the handler decides keys and grants, the processor decides bytes. The same seam the
 * transcriber port cuts for ASR, for the same reason — the suite must be able to run the step
 * without a binary on the machine, and the day the tool changes, one adapter changes.
 */

/** What the processor will produce, asked before any grant is minted so the key can be named. */
export interface ProcessedRendition {
  /** The file extension the output key should carry, without the dot. */
  readonly extension: string;
  /** The content type the upload grant is signed for. */
  readonly contentType: string;
}

export interface AudioProcessRequest {
  /** A signed `GET` for the original. The processor fetches it; the bytes never sit in a queue. */
  readonly sourceUrl: string;
  /** A signed `PUT` for the rendition, bound to {@link ProcessedRendition.contentType}. */
  readonly uploadUrl: string;
  /** The content type the `PUT` was signed for — sent verbatim, or the signature refuses. */
  readonly contentType: string;
}

export interface AudioProcessor {
  /** Which adapter is in use, for the log line and the job's evidence. */
  readonly name: string;

  /**
   * What this processor produces for a source stored with this extension and content type.
   *
   * A function of the source rather than a constant, because the fake copies instead of
   * transcoding — its output *is* the source's format, and a fixed answer would name a format the
   * object is not.
   */
  outputFor(sourceExtension: string, sourceContentType: string): ProcessedRendition;

  /** Produce the rendition and upload it. Failure is a throw, as every handler failure is. */
  process(request: AudioProcessRequest): Promise<void>;
}

/** A processing failure with a sentence an operator can read off the failed job row. */
export class AudioProcessingError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'AudioProcessingError';
  }
}
