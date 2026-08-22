/**
 * **The transcript, as the wire sees it** (Story 5).
 *
 * The segment model has existed since Story 2 — `segment.ts` is the atom, and `packages/db` writes
 * it. This file is the first place it becomes something a *member* asks for, and the shapes here
 * are what the read route answers with and what the correction route accepts.
 *
 * Two shapes rather than one, deliberately. {@link TranscriptSegmentView} is what a member is
 * answered: the words, the offsets and the provider's anonymous speaker index. `correctedAt` and
 * `correctedByUserId` are on the table and on the shared {@link Segment} and are **not here** —
 * who fixed a line is an operator's record, not something a reading surface needs.
 */

import { RECORDINGS_PATH } from './recordings';

/** This recording's transcript, under the API prefix. */
export function recordingTranscriptPath(recordingId: string): string {
  return `${RECORDINGS_PATH}/${recordingId}/transcript`;
}

/** One segment of it, where a correction is `PATCH`ed ([3.5.5](docs/project/prd.md)). */
export function transcriptSegmentPath(recordingId: string, segmentId: string): string {
  return `${recordingTranscriptPath(recordingId)}/segments/${segmentId}`;
}

/**
 * Where a fresh summary is asked for after a correction ([3.5.6](docs/project/prd.md)).
 *
 * A sub-resource of the summary rather than of the transcript: what it produces is a summary draft,
 * and the recording's summary is the thing being regenerated. `POST` for the same reason
 * `reviews/{id}/regenerate` is a `POST` — it spends money at a provider and creates work.
 */
export function recordingSummaryRegeneratePath(recordingId: string): string {
  return `${RECORDINGS_PATH}/${recordingId}/summary/regenerate`;
}

/**
 * One segment, as anyone permitted to read the transcript may.
 *
 * Structurally a subset of {@link Segment} — the same field names, the same units, the same
 * inclusive-start/exclusive-end rule — so nothing has to translate between two ideas of what a
 * segment is.
 */
export interface TranscriptSegmentView {
  readonly id: string;
  /** Inclusive start offset from the beginning of the recording, in milliseconds. */
  readonly startMs: number;
  /** Exclusive end offset from the beginning of the recording, in milliseconds. */
  readonly endMs: number;
  readonly text: string;
  /** The provider's anonymous speaker index, or `null`. Never editable. */
  readonly speaker: number | null;
}

/** The whole transcript in one answer. `null` when the teaching has none yet. */
export interface TranscriptView {
  readonly id: string;
  /** BCP-47. `en` throughout this epic. */
  readonly language: string;
  /** Every segment, in playback order. Unpaginated — ~900 for a 90-minute teaching is one read. */
  readonly segments: readonly TranscriptSegmentView[];
}

/** Payload of `GET /api/v1/recordings/{id}/transcript`. */
export interface TranscriptPayload {
  readonly transcript: TranscriptView | null;
}

/**
 * Body of `PATCH /api/v1/recordings/{id}/transcript/segments/{segmentId}`.
 *
 * All three fields together, always: a correction states what the line now says and where it now
 * sits, and a partial body would make "did the admin mean to leave the timing alone or did the form
 * forget it" a question the API cannot answer. `speaker` is deliberately absent — a request
 * carrying it is refused rather than silently ignored.
 */
export interface CorrectSegmentRequest {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** Payload of the correction — the segment as it now reads. */
export interface CorrectSegmentPayload {
  readonly segment: TranscriptSegmentView;
}

/** Payload of `POST /api/v1/recordings/{id}/summary/regenerate`. */
export interface RegenerateSummaryPayload {
  readonly jobId: string;
  readonly recordingId: string;
}
