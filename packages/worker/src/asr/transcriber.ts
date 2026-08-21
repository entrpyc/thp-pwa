/**
 * **The ASR port — what transcription is, as far as this application is concerned.**
 *
 * One interface, one adapter behind it, and the vendor named in configuration rather than in code —
 * the same shape as the mail and media boundaries, and enforced the same way:
 * tests/guards/asr-boundary.test.ts fails the build if anything outside the adapter imports a
 * provider SDK or names its API. That is the low reversal cost
 * docs/epics/epic-core-listening/architecture.md § Key choices claims for the managed-ASR row, and
 * it is only a claim while this is the only door to a provider.
 *
 * The port takes **where the audio is and what language to transcribe it in**, and answers with
 * segments, one confidence for the whole thing, and what the job cost. Everything vendor-shaped
 * stops at the adapter: nothing downstream sees a channel, an alternative or a word.
 *
 * **A location, not bytes.** The provider is handed a short-lived signed URL and fetches the object
 * itself, so the audio never passes through this process — the same boundary the presigned `PUT`
 * holds on the way in.
 */

export interface TranscriptionRequest {
  /** A URL the provider can fetch the audio from. Short-lived and signed; never a public one. */
  readonly audioUrl: string;
  /**
   * BCP-47. Pinned to English by the caller in this epic (docs/project/prd.md 3.5.7) — a parameter
   * rather than a constant inside the adapter, so a second language later is a call site and an
   * adapter, not a migration.
   */
  readonly language: string;
}

/** One sentence of speech and where it sits. Start inclusive, end exclusive, milliseconds. */
export interface TranscribedSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  /**
   * Who the provider heard, as **its own anonymous index** — `0`, `1`, `2`. Not a name, not a
   * person, and not stable across recordings; nothing downstream turns it into any of those.
   *
   * `null` when the provider attributed the sentence to nobody, which is a real answer and not a
   * failure: a response with no speaker information at all maps to segments that are all null.
   */
  readonly speaker: number | null;
}

/**
 * What the job cost and what produced it, measured rather than estimated
 * ([§7](docs/project/prd.md)). These four facts plus the provider's request id are what
 * `job.provider_meta` carries; the raw response is not persisted and lives in the log line.
 */
export interface TranscriptionSpend {
  readonly model: string;
  readonly modelVersion: string;
  /** The audio length the provider billed for, in seconds — theirs, not ours. */
  readonly durationSeconds: number;
  readonly costUsd: number;
  /** The provider's own id for this call, which is what completes the correlation span. */
  readonly requestId: string;
}

export interface TranscriptionResult {
  /** BCP-47, as transcribed. Echoes the request in this epic; the column is what makes it honest. */
  readonly language: string;
  /** The provider's confidence in the whole transcript, 0..1. What the gate reads. */
  readonly confidence: number;
  readonly segments: readonly TranscribedSegment[];
  readonly spend: TranscriptionSpend;
}

export interface Transcriber {
  /** Which adapter is in use, for the log line. Never a vendor decision made in code. */
  readonly name: string;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

/**
 * What a transcription failed with.
 *
 * One error type for every way the provider can refuse — an HTTP status, a timeout, a body that is
 * not the shape it promised — because as far as the handler is concerned they are the same event:
 * this recording has no transcript and the chain stops. What differs is the message, which is what
 * an operator reads off the failed job row.
 */
export class TranscriptionError extends Error {
  override readonly name = 'TranscriptionError';
}
