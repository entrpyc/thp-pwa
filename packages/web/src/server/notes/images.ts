import { isNoteImageKeyUsed, type NoteImageRow } from '@thp/db';
import {
  ACCEPTED_ARTWORK_LABEL,
  MAX_ARTWORK_BYTES,
  MAX_ARTWORK_LABEL,
  MAX_NOTE_IMAGES,
  MAX_NOTE_IMAGE_ALT_LENGTH,
  describeBytes,
  isAcceptedArtworkType,
  type NoteImageRef,
  type NoteImageView,
  type UploadGrantPayload,
} from '@thp/shared';
import {
  IMAGE_UPLOAD_GRANT_SECONDS,
  NOTE_IMAGE_KEY_PREFIX,
  mediaStore,
  mintNoteImageKey,
  noteImageKeyPrefixFor,
} from '@thp/media';
import { actorGuard } from '@/server/api/actor-limits';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';
import { mintArtworkGrant } from '@/server/series/artwork-grant';

/**
 * **Pictures on notes — the upload, the checks and the store**
 * ([3.12.22](docs/project/prd.md)–[3.12.25](docs/project/prd.md)).
 *
 * The avatar's three-step upload, one resource over: a grant names a key under `note-images/`,
 * the browser puts the bytes there, and the note's write names the key. What is decided here and
 * not in the notes service:
 *
 * 1. **The server believes the store, not the request.** Before a key becomes a row the object is
 *    read back with `head`: it exists, it is under the ceiling, it is an image this accepts, and it
 *    is under the one prefix a grant from here could have named. A key nobody uploaded to, a key
 *    from another prefix and a key another note already carries are each refused by name.
 * 2. **A pending reference is refused.** The offline composer sends one so the outbox can carry
 *    the note; the flush replaces it with a key before the request leaves the device, so one that
 *    reaches the server is a client bug, and `invalid_input` says so.
 * 3. **Deleting an object is best effort, after the commit, loud on failure** — the rule account
 *    deletion set for the avatar. The wrong failure is a note without its picture because the
 *    store blinked; the right one is an orphan under a uuid key, logged for an operator.
 */

const MAX_FIELD_LENGTH = 512;

/** A reference the body carried, read and trimmed: a new upload or an image the note already has. */
export type ParsedImageRef =
  | { readonly kind: 'key'; readonly key: string; readonly alt: string | null }
  | { readonly kind: 'id'; readonly id: string; readonly alt: string | null };

// =================================================================================================
// The grant
// =================================================================================================

export async function grantNoteImageUpload(actor: Actor, body: unknown): Promise<UploadGrantPayload> {
  const requested = parseGrantRequest(body);
  actorGuard().spend('note-image-grant', actor);

  // Minted under the member's own prefix, so the write below can tell whose grant a key came from.
  const key = mintNoteImageKey(requested.contentType, actor.id);
  const expiresAt = new Date(Date.now() + IMAGE_UPLOAD_GRANT_SECONDS * 1000);
  const url = await mediaStore().presignPut({
    key,
    contentType: requested.contentType,
    contentLength: requested.size,
    expiresInSeconds: IMAGE_UPLOAD_GRANT_SECONDS,
  });

  logger.info('note.image.granted', {
    actorId: actor.id,
    action: 'note.write',
    mediaKey: key,
    filename: requested.filename,
    contentType: requested.contentType,
    declaredSize: requested.size,
  });

  return { url, key, contentType: requested.contentType, expiresAt: expiresAt.toISOString() };
}

function parseGrantRequest(body: unknown): {
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
} {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with a filename, a content type and a size.');
  }
  const { filename, contentType, size } = body as Record<string, unknown>;
  if (typeof filename !== 'string' || filename.trim() === '' || filename.length > MAX_FIELD_LENGTH) {
    throw ApiError.invalidInput('Name the picture you are uploading.');
  }
  if (typeof contentType !== 'string' || !isAcceptedArtworkType(contentType)) {
    throw ApiError.invalidInput(`That is not an image this accepts. Upload ${ACCEPTED_ARTWORK_LABEL}.`);
  }
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    throw ApiError.invalidInput('Say how large the picture is, in bytes.');
  }
  if (size > MAX_ARTWORK_BYTES) {
    throw ApiError.invalidInput(`That picture is ${describeBytes(size)}; the limit is ${MAX_ARTWORK_LABEL}.`);
  }
  return { filename: filename.trim(), contentType: contentType.trim().toLowerCase(), size };
}

// =================================================================================================
// Reading the body
// =================================================================================================

/**
 * The `images` field of a write, or none. `allowExisting` is the edit's: a create has no images
 * to keep. The cap, the description's ceiling and a pending reference are each refused in words.
 */
export function parseImageRefs(
  value: unknown,
  options: { readonly allowExisting: boolean },
): ParsedImageRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw ApiError.invalidInput('Send the pictures as a list.');
  if (value.length > MAX_NOTE_IMAGES) {
    throw ApiError.invalidInput(`A note can carry at most ${MAX_NOTE_IMAGES} pictures.`);
  }
  const refs: ParsedImageRef[] = [];
  for (const one of value as unknown[]) {
    if (typeof one !== 'object' || one === null) {
      throw ApiError.invalidInput('Each picture is an object naming its upload.');
    }
    const ref = one as Partial<Record<'key' | 'id' | 'pending' | 'alt', unknown>>;
    const alt = parseAlt(ref.alt);
    if (typeof ref.pending === 'string') {
      throw ApiError.invalidInput(
        'A picture kept on the device has not been uploaded yet. Reconnect and the note will be sent with it.',
      );
    }
    if (typeof ref.key === 'string') {
      const key = ref.key.trim();
      if (key === '' || key.length > MAX_FIELD_LENGTH || !key.startsWith(NOTE_IMAGE_KEY_PREFIX)) {
        throw ApiError.invalidInput('That is not an upload this accepts. Choose the picture again.');
      }
      refs.push({ kind: 'key', key, alt });
      continue;
    }
    if (typeof ref.id === 'string' && options.allowExisting) {
      refs.push({ kind: 'id', id: ref.id.trim(), alt });
      continue;
    }
    throw ApiError.invalidInput('Each picture names the upload it came from.');
  }
  return refs;
}

function parseAlt(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw ApiError.invalidInput('Describe the picture in words, or leave it blank.');
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed === '') return null;
  if (trimmed.length > MAX_NOTE_IMAGE_ALT_LENGTH) {
    throw ApiError.invalidInput(`A picture's description can be at most ${MAX_NOTE_IMAGE_ALT_LENGTH} characters.`);
  }
  return trimmed;
}

/**
 * Read every new upload back from the store before a row names it. Asked before the transaction,
 * so a lying body costs a round trip to the store and nothing in the database.
 */
export async function verifyNewImageKeys(actor: Actor, refs: readonly ParsedImageRef[]): Promise<void> {
  const keys = refs.flatMap((one) => (one.kind === 'key' ? [one.key] : []));
  if (new Set(keys).size !== keys.length) {
    throw refuse(actor, 'duplicate-key', 'The same picture is listed twice.');
  }
  for (const key of keys) {
    // The key has to be one of *this member's* grants (`mintNoteImageKey`): a key copied out of a
    // log or off the wire is otherwise attachable to anybody's note
    // (docs/security-audit-2026-10-29.md, finding 14).
    if (!key.startsWith(noteImageKeyPrefixFor(actor.id))) {
      throw refuse(actor, 'key-not-granted-to-actor', 'That upload is not yours. Choose the picture again.');
    }
    const stored = await mediaStore().head(key);
    if (stored === null) {
      throw refuse(actor, 'nothing-at-key', 'A picture did not finish uploading. Choose it again.');
    }
    if (stored.size > MAX_ARTWORK_BYTES) {
      throw refuse(
        actor,
        'over-ceiling',
        `A picture that arrived is ${describeBytes(stored.size)}; the limit is ${MAX_ARTWORK_LABEL}.`,
      );
    }
    if (!isAcceptedArtworkType(stored.contentType)) {
      throw refuse(actor, 'unaccepted-content-type', `A file that arrived is not an image this accepts. Upload ${ACCEPTED_ARTWORK_LABEL}.`);
    }
    if (await isNoteImageKeyUsed(key)) {
      throw refuse(actor, 'key-in-use', 'That picture already belongs to a note. Choose it again.');
    }
  }
}

function refuse(actor: Actor, reason: string, message: string): ApiError {
  logger.warn('note.image.refused', { actorId: actor.id, action: 'note.write', reason, code: 'invalid_input' });
  return ApiError.invalidInput(message);
}

// =================================================================================================
// Answering and removing
// =================================================================================================

/** The pictures of many notes, signed into URLs and keyed by note — one signature per picture. */
export async function signNoteImages(
  rows: readonly NoteImageRow[],
): Promise<ReadonlyMap<string, NoteImageView[]>> {
  const urls = await Promise.all(rows.map((row) => mintArtworkGrant(row.mediaKey)));
  const byNote = new Map<string, NoteImageView[]>();
  rows.forEach((row, index) => {
    const url = urls[index];
    if (url === null || url === undefined) return;
    const held = byNote.get(row.noteId) ?? [];
    held.push({ id: row.id, url, alt: row.alt });
    byNote.set(row.noteId, held);
  });
  return byNote;
}

/** After the commit, best effort, loud on failure — the avatar's rule. The key is in the line. */
export async function deleteNoteImageObjects(actor: Actor, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    try {
      await mediaStore().deleteNoteImage(key);
    } catch (cause) {
      logger.error('note.image.orphaned', {
        actorId: actor.id,
        mediaKey: key,
        errorMessage: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}
