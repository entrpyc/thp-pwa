import { findVisibleRecording } from '@thp/db';
import type { PlaybackGrantPayload } from '@thp/shared';
import { mediaStore } from '@thp/media';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';

/**
 * **The one place a playback URL is minted** (Story 4 Ticket 02).
 *
 * It is one function on purpose, and the reason is written down in
 * docs/epics/epic-core-listening/architecture.md § Extension points under *Second media pointer*:
 * [§3.4](docs/project/prd.md) later gives a recording a processed rendition and makes playback
 * prefer it, falling back to the original — and that is a change to one function only if there is
 * one of it. A second call site is what turns a back-fill that runs recording by recording into a
 * search of the codebase.
 *
 * **The authorisation happens before anything is signed.** The recording must be published and the
 * caller must hold `recording.browse`; only then does the store see a request. A signed URL is a
 * bearer token for an object, so a refusal has to cost the caller a request and leave nothing
 * behind that could be replayed.
 *
 * **The API is in the authorisation path and never in the audio path.** What crosses the wire is a
 * grant; the bytes go from the object store to the browser directly, which is what makes range
 * requests — and therefore scrubbing ([3.2.9](docs/project/prd.md)) — work without a CDN.
 */

/**
 * One hour.
 *
 * A 90-minute teaching outlasts any sensible URL lifetime, and lengthening the grant until it does
 * not is the wrong end of the trade: what a longer expiry buys is one fewer request per sitting,
 * and what it costs is that a URL copied out of a network tab stays live for the afternoon. So the
 * grant stays short and **the client renews it** — on the element erroring, or ahead of expiry,
 * restoring position and play state either way. The member does not notice; the copied URL still
 * dies within the hour.
 */
export const PLAYBACK_GRANT_SECONDS = 60 * 60;

export async function mintPlaybackGrant(
  actor: Actor,
  recordingId: string,
): Promise<PlaybackGrantPayload> {
  // Published only, whatever the caller's role. An admin listening to a teaching is listening to
  // the same library a member is; the console is where unpublished rows live.
  const row = await findVisibleRecording(recordingId, { includeUnpublished: false });

  if (row === null) {
    logger.warn('recording.playback.refused', {
      actorId: actor.id,
      action: 'recording.browse',
      target: `recording:${recordingId}`,
      reason: 'not-published',
      code: 'not_found',
    });
    throw ApiError.notFound('There is no such teaching.');
  }

  const expiresAt = new Date(Date.now() + PLAYBACK_GRANT_SECONDS * 1000);
  const url = await mediaStore().presignGet({
    key: row.originalMediaKey,
    expiresInSeconds: PLAYBACK_GRANT_SECONDS,
  });

  logger.info('recording.playback.granted', {
    actorId: actor.id,
    action: 'recording.browse',
    target: `recording:${row.id}`,
    // The key is logged, never returned: an operator tracing a failed listen needs to know which
    // object it was, and a client has no business being able to name one.
    mediaKey: row.originalMediaKey,
    expiresAt: expiresAt.toISOString(),
  });

  return { url, expiresAt: expiresAt.toISOString() };
}
