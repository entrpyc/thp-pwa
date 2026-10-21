import {
  findPlaybackProgress,
  findResumeProgress,
  findVisibleRecording,
  recordPlaybackProgress,
  setPreferredPlaybackSpeed,
} from '@thp/db';
import {
  MAX_LISTENED_DELTA_MS,
  MIN_STORED_POSITION_MS,
  isPlaybackSpeed,
  type PlaybackProgressPayload,
  type PlaybackProgressRequest,
  type PlaybackSpeedPayload,
  type PlaybackSpeedRequest,
  type ResumePayload,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { mintArtworkGrant } from '@/server/series/artwork-grant';
import { trackFor } from '@/server/observability/analytics';
import { logger } from '@/server/observability/logger';

/**
 * **The two pieces of playback state a member owns**: the speed they listen at, and where they had
 * got to (Story 4 Tickets 03 and 04).
 *
 * Both are held client-side while a member is listening and pushed here — which is the shape
 * core-listening scope tdd § Extension points calls *Client-owned playback
 * state*, and the reason [§3.18](docs/project/prd.md)'s offline sync is an addition rather than a
 * rewrite. The endpoint takes **a position, not a stream of events**: there is no history to
 * reconcile, no outbox and no batch, and adding those later is a second endpoint beside this one.
 *
 * Neither write consults the recording's visibility. Progress against a teaching that has since
 * been taken down stays where it is — the resume card is what filters, so re-publishing brings the
 * position back rather than the member losing it.
 */

/** Set the account's playback speed ([3.2.4](docs/project/prd.md)). */
export async function writePlaybackSpeed(
  actor: Actor,
  body: unknown,
): Promise<PlaybackSpeedPayload> {
  const speed = parseSpeed(body);
  const written = await setPreferredPlaybackSpeed(actor.id, speed);
  if (written === null) throw ApiError.notFound('There is no such account.');

  logger.info('playback.speed.set', {
    actorId: actor.id,
    action: 'playback.speed',
    target: `user:${actor.id}`,
    speed: written,
  });

  return { speed: written };
}

/**
 * Store where this member has got to.
 *
 * **The floor is applied here as well as in the client.** A position under five seconds is not a
 * resume point, and a rule the client alone applied would be a rule anything else holding a session
 * could ignore — the refusal is what makes "opening a teaching and closing it leaves nothing
 * behind" true rather than customary.
 */
export async function writePlaybackProgress(
  actor: Actor,
  recordingId: string,
  body: unknown,
): Promise<PlaybackProgressPayload> {
  const positionMs = parsePosition(body);
  const listened = parseListening(body);

  // The recording has to exist and be one this member may read; otherwise a session is a licence to
  // write rows keyed on any uuid at all.
  const recording = await findVisibleRecording(recordingId, { includeUnpublished: false });
  if (recording === null) throw ApiError.notFound('There is no such teaching.');

  const { row, completedNow } = await recordPlaybackProgress({
    userId: actor.id,
    recordingId,
    positionMs,
    ...listened,
  });

  logger.info('playback.progress.written', {
    actorId: actor.id,
    action: 'playback.progress',
    target: `recording:${recordingId}`,
    positionMs: row.positionMs,
    listenedMs: row.listenedMs,
    completed: completedNow,
  });

  // The one event the server sends (docs/project/observability.md § 5.3), the one time it is true.
  if (completedNow) {
    trackFor(actor.id, 'playback_completed', {
      recording_id: recordingId,
      series_id: recording.seriesId,
    });
  }

  return {
    positionMs: row.positionMs,
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** Where this member had got to, or nothing. Read by the recording page as it loads. */
export async function readPlaybackProgress(
  actor: Actor,
  recordingId: string,
): Promise<PlaybackProgressPayload> {
  const row = await findPlaybackProgress(actor.id, recordingId);
  return row === null
    ? { positionMs: null, updatedAt: null, completedAt: null }
    : {
        positionMs: row.positionMs,
        updatedAt: row.updatedAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
      };
}

/** What the landing offers to pick back up, or nothing to offer. */
export async function readResume(actor: Actor): Promise<ResumePayload> {
  const row = await findResumeProgress(actor.id);
  return {
    resume:
      row === null
        ? null
        : {
            recordingId: row.recordingId,
            title: row.title,
            description: row.description,
            positionMs: row.positionMs,
            // Signed here and nowhere lower: the key is a database fact and the grant is a response
            // this request minted, which is the same split every other artwork read takes.
            seriesTitle: row.seriesTitle,
            seriesId: row.seriesId,
            artworkUrl: await mintArtworkGrant(row.seriesArtworkKey),
          },
  };
}

function parseSpeed(body: unknown): number {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with a speed.');
  }
  const { speed } = body as Partial<PlaybackSpeedRequest>;
  // The six, and nothing between them. The control cannot produce another value and neither can
  // the column, so a request carrying one is a request from something that is not the player.
  if (!isPlaybackSpeed(speed)) {
    throw ApiError.invalidInput('That is not a playback speed this offers.');
  }
  return speed;
}

function parsePosition(body: unknown): number {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with a position in milliseconds.');
  }
  const { positionMs } = body as Partial<PlaybackProgressRequest>;
  if (typeof positionMs !== 'number' || !Number.isInteger(positionMs) || positionMs < 0) {
    throw ApiError.invalidInput('Give the position as whole milliseconds from the start.');
  }
  if (positionMs < MIN_STORED_POSITION_MS) {
    throw ApiError.invalidInput('That is too near the start to be worth resuming from.');
  }
  return positionMs;
}

/**
 * What was heard, and how long the teaching is — both optional, because a client from before
 * this release sends neither and its position must still land. A delta past
 * {@link MAX_LISTENED_DELTA_MS} is clamped rather than refused: the position beside it is still
 * true, and a clock that ran ahead should cost a count, not a resume point.
 */
function parseListening(body: unknown): { listenedDeltaMs?: number; durationMs?: number } {
  const { listenedMs, durationMs } = body as Partial<PlaybackProgressRequest>;
  const parsed: { listenedDeltaMs?: number; durationMs?: number } = {};
  if (listenedMs !== undefined) {
    if (typeof listenedMs !== 'number' || !Number.isInteger(listenedMs) || listenedMs < 0) {
      throw ApiError.invalidInput('Give what was heard as whole, non-negative milliseconds.');
    }
    parsed.listenedDeltaMs = Math.min(listenedMs, MAX_LISTENED_DELTA_MS);
  }
  if (durationMs !== undefined) {
    if (typeof durationMs !== 'number' || !Number.isInteger(durationMs) || durationMs <= 0) {
      throw ApiError.invalidInput('Give the duration as whole, positive milliseconds.');
    }
    parsed.durationMs = durationMs;
  }
  return parsed;
}
