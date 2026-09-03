import { findUserById, setUserAvatar } from '@thp/db';
import {
  ACCEPTED_ARTWORK_LABEL,
  MAX_ARTWORK_BYTES,
  MAX_ARTWORK_LABEL,
  describeBytes,
  isAcceptedArtworkType,
  type AvatarGrantRequest,
  type SessionPayload,
  type SetAvatarRequest,
  type UploadGrantPayload,
} from '@thp/shared';
import { UPLOAD_GRANT_SECONDS, mediaStore, mintAvatarKey } from '@thp/media';
import { ApiError } from '@/server/api/errors';
import { toActor, type Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';
import { describeSessionUser } from './session-user';

/**
 * **The avatar — a grant, a finalisation, and a removal** (docs/project/prd.md 3.1.12).
 *
 * The series cover's flow, one resource over, and it earns the shape the same way: the browser
 * sends the bytes straight to the store under a grant minted here, and finalisation believes the
 * store rather than the request. Everything that made that flow safe is kept, and one thing is
 * simpler: **there is no resource to look up and no ownership to decide.** The route is `me`, so
 * the account being written is the one the session resolved to, and a path that could name somebody
 * else's avatar does not exist to be refused.
 *
 * The image vocabulary is the cover's — the three accepted types, the 4 MB ceiling, the WebP the
 * browser re-encodes to. A second vocabulary for a smaller picture would be a second thing the
 * screen and the API could disagree about, and the ceiling is a bound on what a member may send
 * rather than a target the re-encode aims at; a 512 px WebP is a small fraction of it.
 */

/** The most a field can be before we stop reading it — the same generic ceiling every route applies. */
const MAX_FIELD_LENGTH = 512;

/**
 * **Permission to send the picture, and nothing else.**
 *
 * Every refusal happens before the store is asked for anything, so a rejected format or an
 * oversized declaration costs a request and leaves no URL behind — an error carrying a presigned
 * `PUT` is an error a client could ignore.
 */
export async function grantAvatarUpload(actor: Actor, body: unknown): Promise<UploadGrantPayload> {
  const requested = parseGrantRequest(body);

  const key = mintAvatarKey(requested.contentType);
  const expiresAt = new Date(Date.now() + UPLOAD_GRANT_SECONDS * 1000);
  const url = await mediaStore().presignPut({
    key,
    contentType: requested.contentType,
    expiresInSeconds: UPLOAD_GRANT_SECONDS,
  });

  logger.info('profile.avatar.granted', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'profile.update',
    target: `account:${actor.id}`,
    mediaKey: key,
    // What the person chose it as, so an operator reading the log can tell which upload this was.
    // It is not what the key is built from — see `mintAvatarKey`.
    filename: requested.filename,
    contentType: requested.contentType,
    declaredSize: requested.size,
  });

  return { url, key, contentType: requested.contentType, expiresAt: expiresAt.toISOString() };
}

/**
 * **Point the account at the picture that landed.**
 *
 * The key is read first, so a malformed request is refused without a round trip to the store; then
 * the store is asked what is actually behind it, because that is the only thing "re-checked
 * server-side" can mean when the API never sees the file; and only then is the pointer written. A
 * client that declared 1 KB and uploaded 3 MB gets a grant it cannot finalise.
 *
 * **Every refusal leaves the avatar exactly as it was.** Nothing is written before all three checks
 * pass. The object behind a refused key stays in the bucket, invisible — there is nothing to
 * delete it with, by design.
 *
 * Answers with the whole session payload rather than a URL alone, because the screen that called
 * is the screen that renders the session user, and a second read to learn what it just wrote would
 * be a round trip for one field.
 */
export async function setAvatar(actor: Actor, body: unknown): Promise<SessionPayload> {
  const key = parseKey(body);

  const stored = await mediaStore().head(key);
  if (stored === null) {
    throw refuse(actor, 'nothing-at-key', 'That upload did not finish. Choose the picture again.');
  }
  if (stored.size > MAX_ARTWORK_BYTES) {
    throw refuse(
      actor,
      'over-ceiling',
      `The picture that arrived is ${describeBytes(stored.size)}; the limit is ${MAX_ARTWORK_LABEL}.`,
    );
  }
  if (!isAcceptedArtworkType(stored.contentType)) {
    throw refuse(
      actor,
      'unaccepted-content-type',
      `The file that arrived is not an image this accepts. Upload ${ACCEPTED_ARTWORK_LABEL}.`,
    );
  }

  const row = await setUserAvatar(actor.id, key);
  if (row === null) throw ApiError.notFound('There is no such account.');

  logger.info('profile.avatar', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'profile.update',
    target: `account:${actor.id}`,
    mediaKey: key,
    size: stored.size,
    contentType: stored.contentType,
  });

  return { user: await describeSessionUser(toActor(row)) };
}

/**
 * **Take the picture away.** The pointer goes to `null` — the state every account starts in — and
 * the object stays where it is. Removing an avatar that is already absent is not an error: the
 * account is in the state that was asked for, and a control that is idempotent is one a screen can
 * safely retry after a lost response.
 */
export async function clearAvatar(actor: Actor): Promise<SessionPayload> {
  const current = await findUserById(actor.id);
  if (current === null) throw ApiError.notFound('There is no such account.');

  const row = current.avatarKey === null ? current : await setUserAvatar(actor.id, null);
  if (row === null) throw ApiError.notFound('There is no such account.');

  logger.info('profile.avatar.cleared', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'profile.update',
    target: `account:${actor.id}`,
    changed: current.avatarKey !== null,
  });

  return { user: await describeSessionUser(toActor(row)) };
}

function refuse(actor: Actor, reason: string, message: string): ApiError {
  logger.warn('profile.avatar.refused', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'profile.update',
    target: `account:${actor.id}`,
    reason,
    code: 'invalid_input',
  });
  return ApiError.invalidInput(message);
}

function parseGrantRequest(body: unknown): {
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
} {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with a filename, a content type and a size.');
  }
  const { filename, contentType, size } = body as Partial<AvatarGrantRequest>;

  if (typeof filename !== 'string' || filename.trim() === '' || filename.length > MAX_FIELD_LENGTH) {
    throw ApiError.invalidInput('Name the picture you are uploading.');
  }
  if (typeof contentType !== 'string' || !isAcceptedArtworkType(contentType)) {
    throw ApiError.invalidInput(
      `That is not an image this accepts. Upload ${ACCEPTED_ARTWORK_LABEL}.`,
    );
  }
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    throw ApiError.invalidInput('Say how large the picture is, in bytes.');
  }
  if (size > MAX_ARTWORK_BYTES) {
    throw ApiError.invalidInput(
      `That picture is ${describeBytes(size)}; the limit is ${MAX_ARTWORK_LABEL}.`,
    );
  }

  return { filename: filename.trim(), contentType: contentType.trim().toLowerCase(), size };
}

function parseKey(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with the key of the upload.');
  }
  const { key } = body as Partial<SetAvatarRequest>;
  if (typeof key !== 'string' || key.trim() === '' || key.length > MAX_FIELD_LENGTH) {
    throw ApiError.invalidInput('Name the upload this picture is.');
  }
  return key.trim();
}
