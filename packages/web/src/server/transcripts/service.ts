import {
  correctSegment,
  findSegmentById,
  findSegmentNeighbours,
  findTranscriptByRecording,
  findVisibleRecording,
  listSegments,
  withTransaction,
  type SegmentRow,
} from '@thp/db';
import type {
  CorrectSegmentPayload,
  CorrectSegmentRequest,
  RegenerateSummaryPayload,
  TranscriptPayload,
  TranscriptSegmentView,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { queue } from '@/server/jobs/queue';
import { logger } from '@/server/observability/logger';

/**
 * **The transcript, read and corrected** ([3.5.3](docs/project/prd.md)–
 * [3.5.6](docs/project/prd.md)).
 *
 * Three things happen here:
 *
 * 1. **The whole transcript is read**, through the visibility condition and nothing else. The gate
 *    is `findVisibleRecording` — the module tests/guards/visibility-boundary.test.ts makes the only
 *    place `published_at` is compared — so this is the fifth read path over those rows and still
 *    the first statement of the rule.
 * 2. **A segment is corrected**, with `corrected_at` and `corrected_by_user_id` written and the
 *    neighbour rule enforced **inside the same transaction as the update**. That is the whole of
 *    what keeps the transcript's order an order: two corrections landing together cannot cross each
 *    other, so `(transcript_id, start_ms)` stays the ordering it claims to be.
 * 3. **A fresh summary is asked for**, through the queue port and the existing `generate_draft`
 *    step. Nothing here writes a summary and nothing here publishes one — the draft lands in the
 *    Pending Reviews queue and an admin's approval is what replaces the live text
 *    ([4.17.3](docs/project/prd.md)).
 *
 * **Published recordings only.** Both writes read the recording through the member gate, so an
 * unpublished id is `not_found` here exactly as it is on the read — which is why this epic grows no
 * admin transcript surface and no `?surface=` parameter on the route.
 *
 * Every correction and every regeneration is logged with actor, action, target and timestamp — the
 * standing constraint of docs/epics/epic-core-listening/implementation-plan.md § Standing
 * constraints, and the same `logger.info` shape the review gate's transitions use.
 */

/** The most a corrected line may be. The same ceiling the review gate applies to a draft field. */
const MAX_FIELD_LENGTH = 20_000;

/**
 * The whole transcript of a published teaching, or `null` when it has none.
 *
 * **One response, unpaginated.** ~900 segments for a 90-minute teaching is one read of an indexed
 * range; pagination would be machinery with no reader, and the follow-along needs all of it anyway
 * to answer "which segment covers this offset" without a round trip per tick.
 */
export async function readTranscriptFor(
  actor: Actor,
  recordingId: string,
): Promise<TranscriptPayload> {
  await requirePublished(actor, recordingId, 'recording.browse');

  const transcript = await findTranscriptByRecording(recordingId);
  if (transcript === null) {
    logger.info('transcript.read', {
      actorId: actor.id,
      action: 'recording.browse',
      target: `recording:${recordingId}`,
      segments: 0,
    });
    return { transcript: null };
  }

  const segments = await listSegments(transcript.id);

  logger.info('transcript.read', {
    actorId: actor.id,
    action: 'recording.browse',
    target: `transcript:${transcript.id}`,
    segments: segments.length,
  });

  return {
    transcript: {
      id: transcript.id,
      language: transcript.language,
      segments: segments.map(describeSegment),
    },
  };
}

/**
 * Correct one segment's words and its timings.
 *
 * **The containment is the neighbour rule.** The operator chose editable timings, which means an
 * offset a member has already seeked to can move under them; what stops that from being a
 * transcript whose order changed is that a correction must stay inside its neighbours —
 * `startMs >= previous.endMs` and `endMs <= next.startMs`. Gaps are allowed, because widening a
 * silence is a legitimate correction; overlaps are not, because they would make "which segment
 * covers this offset" have two answers.
 *
 * The first segment's floor is `0` and the last has no ceiling: nothing in this epic stores a
 * duration, so there is nothing to compare a final `endMs` against.
 */
export async function correctTranscriptSegment(
  actor: Actor,
  recordingId: string,
  segmentId: string,
  body: unknown,
): Promise<CorrectSegmentPayload> {
  await requirePublished(actor, recordingId, 'transcript.correct');
  const requested = parseCorrection(body);

  const transcript = await findTranscriptByRecording(recordingId);
  if (transcript === null) throw ApiError.notFound('That teaching has no transcript to correct.');

  const corrected = await withTransaction(async (tx) => {
    // Re-read inside the transaction: the row this correction is checked against has to be the row
    // it is applied to, or two admins correcting adjacent lines could each pass against a state
    // neither of them writes.
    const existing = await findSegmentById(segmentId, tx);
    if (existing === null || existing.transcriptId !== transcript.id) {
      throw ApiError.notFound('There is no such line in this transcript.');
    }

    const { previous, next } = await findSegmentNeighbours(existing, tx);
    if (previous !== null && requested.startMs < previous.endMs) {
      throw ApiError.invalidInput(
        'That start is inside the line before it. Lines cannot overlap — move the earlier line first.',
      );
    }
    if (next !== null && requested.endMs > next.startMs) {
      throw ApiError.invalidInput(
        'That end is inside the line after it. Lines cannot overlap — move the later line first.',
      );
    }

    return correctSegment(
      {
        id: segmentId,
        text: requested.text,
        startMs: requested.startMs,
        endMs: requested.endMs,
        correctedByUserId: actor.id,
      },
      tx,
    );
  });

  logger.info('transcript.correct', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'transcript.correct',
    target: `segment:${segmentId}`,
    recordingId,
    transcriptId: transcript.id,
    startMs: corrected.startMs,
    endMs: corrected.endMs,
  });

  return { segment: describeSegment(corrected) };
}

/**
 * Ask for a summary built on the corrected words ([3.5.6](docs/project/prd.md)).
 *
 * **A new draft, not a replacement.** The enqueue produces a fresh open `review_item` through the
 * existing `generate_draft` handler, and the published `summary` row is left exactly where it is —
 * so the live summary never goes dark and is replaced only by the same approve press that publishes
 * any other draft. That is what makes this path different from [3.6.9](docs/project/prd.md)'s
 * discard-and-replace of an open draft: nothing is discarded here.
 *
 * **One generation in flight per recording.** The same unfinished-job check `regenerateReview`
 * makes, for the same reason: the partial unique index over `(recording_id, step)` would otherwise
 * turn the second enqueue into a no-op wearing a success.
 */
export async function regenerateSummary(
  actor: Actor,
  recordingId: string,
): Promise<RegenerateSummaryPayload> {
  await requirePublished(actor, recordingId, 'summary.regenerate');

  const inFlight = await queue().findUnfinished(recordingId, 'generate_draft');
  if (inFlight !== null) {
    throw new ApiError(
      'generation_in_flight',
      409,
      'A draft for this recording is already being generated. Wait for it to finish, then try again.',
    );
  }

  const enqueued = await queue().enqueue({
    recordingId,
    step: 'generate_draft',
    // The summary and nothing else: mind maps, scripture references and tags do not exist yet, so
    // the offer names the one derived artefact this product has.
    payload: { kinds: ['summary'] },
  });

  logger.info('summary.regenerate', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'summary.regenerate',
    target: `recording:${recordingId}`,
    recordingId,
    jobId: enqueued.id,
    attempt: enqueued.attempt,
  });

  return { jobId: enqueued.id, recordingId };
}

/**
 * The recording, read through the member gate, or the refusal every caller here gets.
 *
 * `not_found` for an unpublished id and for one that never existed alike, so the API does not
 * report which ids exist — the same answer `readRecordingFor` gives, reached the same way.
 */
async function requirePublished(actor: Actor, recordingId: string, action: string): Promise<void> {
  const row = await findVisibleRecording(recordingId, { includeUnpublished: false });
  if (row !== null) return;

  logger.warn('transcript.refused', {
    actorId: actor.id,
    action,
    target: `recording:${recordingId}`,
    reason: 'not-visible',
    code: 'not_found',
  });
  throw ApiError.notFound('There is no such teaching.');
}

/** The row, as a reader is answered. The two corrected-by columns do not cross the wire. */
function describeSegment(row: SegmentRow): TranscriptSegmentView {
  return {
    id: row.id,
    startMs: row.startMs,
    endMs: row.endMs,
    text: row.text,
    speaker: row.speaker,
  };
}

function parseCorrection(body: unknown): CorrectSegmentRequest {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with the corrected text and its timings.');
  }
  const { text, startMs, endMs } = body as Partial<CorrectSegmentRequest>;

  // Refused rather than ignored: the speaker is the provider's anonymous index, and a client that
  // thinks it can set one should learn that it cannot rather than watch the value disappear.
  if ('speaker' in (body as Record<string, unknown>)) {
    throw ApiError.invalidInput('The speaker is not something a correction can change.');
  }

  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_FIELD_LENGTH) {
    throw ApiError.invalidInput('Give the line some text.');
  }
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) {
    throw ApiError.invalidInput('Give the start and the end as whole milliseconds.');
  }
  const start = startMs as number;
  const end = endMs as number;
  if (start < 0) throw ApiError.invalidInput('A line cannot start before the recording does.');
  if (start >= end) throw ApiError.invalidInput('A line has to end after it starts.');

  return { text: text.trim(), startMs: start, endMs: end };
}
