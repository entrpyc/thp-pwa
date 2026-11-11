import {
  deleteReleaseNote,
  findReleaseNoteById,
  insertReleaseNote,
  listReleaseNotes,
  updateReleaseNote,
  type ReleaseNoteRow,
} from '@thp/db';
import { IMAGE_UPLOAD_GRANT_SECONDS, mediaStore, mintReleaseNoteImageKey } from '@thp/media';
import {
  ACCEPTED_RELEASE_NOTE_IMAGE_LABEL,
  MAX_RELEASE_NOTE_IMAGE_BYTES,
  MAX_RELEASE_NOTE_IMAGE_LABEL,
  MAX_RELEASE_NOTE_TITLE_LENGTH,
  RELEASE_NOTES_PAGE_PATH,
  ReleaseNoteDocError,
  describeBytes,
  isAcceptedReleaseNoteImageType,
  mapReleaseNoteImages,
  parseReleaseNoteDoc,
  releaseNoteExcerpt,
  releaseNoteImageKeys,
  type DeleteReleaseNotePayload,
  type EditorImageAttrs,
  type ReleaseNoteListPayload,
  type ReleaseNotePayload,
  type ReleaseNoteSourcePayload,
  type ReleaseNoteSummary,
  type SaveReleaseNotePayload,
  type StoredReleaseNoteDoc,
  type UploadGrantPayload,
  type ViewImageAttrs,
} from '@thp/shared';
import { actorGuard } from '@/server/api/actor-limits';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { audit } from '@/server/observability/audit';
import { logger } from '@/server/observability/logger';
import { mintArtworkGrant } from '@/server/series/artwork-grant';

/**
 * **Release notes — reading them, writing them, and the pictures inside them.**
 *
 * Who may do which is the route's question (`release-note.*` in the policy table); by the time a
 * function here runs the caller has been admitted. What this file is careful about:
 *
 * 1. **The body is read once, by the shared parser.** `parseReleaseNoteDoc` turns what the editor
 *    sent into the document that is stored and refuses anything else by name. Nothing past that
 *    line handles an unknown node, and nothing anywhere handles markup.
 * 2. **The server believes the store, not the request.** A picture the post did not already carry
 *    is read back with `head` before the row names it: it exists, it is under the ceiling and it
 *    is an image this accepts. Pictures the post already had are not re-read — they passed once.
 * 3. **A member is handed URLs and never keys.** A read signs each picture; only the editor's own
 *    read (`release-note.edit`) carries the key beside the URL, because the editor has to send it
 *    back.
 * 4. **Nothing is deleted from the store.** A picture taken out of a post, and a deleted post's
 *    pictures, stay where they are, unreferenced — the media port has no delete to call for them.
 */

const MAX_FIELD_LENGTH = 512;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_SUCH_POST = 'There is no such release note.';

// =================================================================================================
// Reading
// =================================================================================================

function summarise(row: ReleaseNoteRow): ReleaseNoteSummary {
  return {
    id: row.id,
    title: row.title,
    excerpt: releaseNoteExcerpt(row.body),
    publishedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Sign every picture of a document once, keyed by its upload key. */
async function signImages(doc: StoredReleaseNoteDoc): Promise<ReadonlyMap<string, string>> {
  const keys = [...new Set(releaseNoteImageKeys(doc))];
  const urls = await Promise.all(keys.map((key) => mintArtworkGrant(key)));
  const signed = new Map<string, string>();
  keys.forEach((key, index) => {
    const url = urls[index];
    if (typeof url === 'string') signed.set(key, url);
  });
  return signed;
}

async function requireRow(id: string): Promise<ReleaseNoteRow> {
  // A path segment that is not a uuid is not a post; asked of the database it would be a cast
  // error rather than an absence.
  const row = UUID.test(id) ? await findReleaseNoteById(id) : null;
  if (row === null) throw ApiError.notFound(NO_SUCH_POST);
  return row;
}

export async function listReleaseNotesFor(): Promise<ReleaseNoteListPayload> {
  const rows = await listReleaseNotes();
  return { releaseNotes: rows.map(summarise) };
}

export async function readReleaseNoteFor(id: string): Promise<ReleaseNotePayload> {
  const row = await requireRow(id);
  const signed = await signImages(row.body);
  const body = mapReleaseNoteImages(row.body, (attrs): ViewImageAttrs | null => {
    const src = signed.get(attrs.key);
    return src === undefined ? null : { src, alt: attrs.alt };
  });
  return { releaseNote: { ...summarise(row), body } };
}

/** The post as the editor opens it — the one read that carries keys. */
export async function readReleaseNoteSourceFor(
  actor: Actor,
  id: string,
): Promise<ReleaseNoteSourcePayload> {
  const row = await requireRow(id);
  const signed = await signImages(row.body);
  const body = mapReleaseNoteImages(row.body, (attrs): EditorImageAttrs | null => {
    const src = signed.get(attrs.key);
    return src === undefined ? null : { key: attrs.key, src, alt: attrs.alt };
  });
  logger.info('release-note.source', {
    actorId: actor.id,
    action: 'release-note.edit',
    target: `release-note:${id}`,
  });
  return { releaseNote: { ...summarise(row), body } };
}

/** Whether a post exists — what a new-feature send asks before it points every member at one. */
export async function releaseNoteExists(id: string): Promise<boolean> {
  return UUID.test(id) && (await findReleaseNoteById(id)) !== null;
}

// =================================================================================================
// Writing
// =================================================================================================

function parseSave(body: unknown): { readonly title: string; readonly doc: StoredReleaseNoteDoc } {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with a title and a body.');
  }
  const fields = body as Record<string, unknown>;
  const rawTitle = fields['title'];
  if (typeof rawTitle !== 'string' || rawTitle.trim() === '') {
    throw ApiError.invalidInput('Give the post a title.');
  }
  const title = rawTitle.trim();
  if (title.length > MAX_RELEASE_NOTE_TITLE_LENGTH) {
    throw ApiError.invalidInput(
      `The title can be at most ${MAX_RELEASE_NOTE_TITLE_LENGTH} characters.`,
    );
  }
  try {
    return { title, doc: parseReleaseNoteDoc(fields['body']) };
  } catch (caught) {
    if (caught instanceof ReleaseNoteDocError) throw ApiError.invalidInput(caught.message);
    throw caught;
  }
}

function refuseImage(actor: Actor, reason: string, message: string): ApiError {
  logger.warn('release-note.image.refused', { actorId: actor.id, reason, code: 'invalid_input' });
  return ApiError.invalidInput(message);
}

/** Read each picture the post did not already carry back from the store before a row names it. */
async function verifyNewImages(
  actor: Actor,
  doc: StoredReleaseNoteDoc,
  alreadyHeld: ReadonlySet<string>,
): Promise<void> {
  const fresh = [...new Set(releaseNoteImageKeys(doc))].filter((key) => !alreadyHeld.has(key));
  for (const key of fresh) {
    const stored = await mediaStore().head(key);
    if (stored === null) {
      throw refuseImage(
        actor,
        'nothing-at-key',
        'A picture did not finish uploading. Remove it and add it again.',
      );
    }
    if (stored.size > MAX_RELEASE_NOTE_IMAGE_BYTES) {
      throw refuseImage(
        actor,
        'over-ceiling',
        `A picture that arrived is ${describeBytes(stored.size)}; the limit is ${MAX_RELEASE_NOTE_IMAGE_LABEL}.`,
      );
    }
    if (!isAcceptedReleaseNoteImageType(stored.contentType)) {
      throw refuseImage(
        actor,
        'unaccepted-content-type',
        `A file that arrived is not an image this accepts. Upload ${ACCEPTED_RELEASE_NOTE_IMAGE_LABEL}.`,
      );
    }
  }
}

export async function createReleaseNoteFor(
  actor: Actor,
  body: unknown,
): Promise<SaveReleaseNotePayload> {
  const { title, doc } = parseSave(body);
  await verifyNewImages(actor, doc, new Set());
  const row = await insertReleaseNote({ title, body: doc, createdBy: actor.id });
  logger.info('release-note.create', audit(actor, 'release-note.create', `release-note:${row.id}`));
  return { releaseNote: summarise(row) };
}

export async function editReleaseNoteFor(
  actor: Actor,
  id: string,
  body: unknown,
): Promise<SaveReleaseNotePayload> {
  const existing = await requireRow(id);
  const { title, doc } = parseSave(body);
  await verifyNewImages(actor, doc, new Set(releaseNoteImageKeys(existing.body)));
  const row = await updateReleaseNote(id, { title, body: doc });
  if (row === null) throw ApiError.notFound(NO_SUCH_POST);
  logger.info('release-note.edit', audit(actor, 'release-note.edit', `release-note:${row.id}`));
  return { releaseNote: summarise(row) };
}

export async function deleteReleaseNoteFor(
  actor: Actor,
  id: string,
): Promise<DeleteReleaseNotePayload> {
  await requireRow(id);
  // Notices that opened this post are moved to the list rather than left pointing at a 404.
  const removed = await deleteReleaseNote(id, RELEASE_NOTES_PAGE_PATH);
  if (!removed) throw ApiError.notFound(NO_SUCH_POST);
  logger.info('release-note.delete', audit(actor, 'release-note.delete', `release-note:${id}`));
  return { deleted: true };
}

// =================================================================================================
// The upload grant
// =================================================================================================

/**
 * Permission to send one picture for a post: the grant half of the avatar's three-step upload. The
 * key is minted here under `release-notes/`; the save that names it reads the object back.
 */
export async function grantReleaseNoteImageUpload(
  actor: Actor,
  body: unknown,
): Promise<UploadGrantPayload> {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with a filename, a content type and a size.');
  }
  const { filename, contentType, size } = body as Record<string, unknown>;
  if (typeof filename !== 'string' || filename.trim() === '' || filename.length > MAX_FIELD_LENGTH) {
    throw ApiError.invalidInput('Name the picture you are uploading.');
  }
  if (typeof contentType !== 'string' || !isAcceptedReleaseNoteImageType(contentType)) {
    throw ApiError.invalidInput(
      `That is not an image this accepts. Upload ${ACCEPTED_RELEASE_NOTE_IMAGE_LABEL}.`,
    );
  }
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    throw ApiError.invalidInput('Say how large the picture is, in bytes.');
  }
  if (size > MAX_RELEASE_NOTE_IMAGE_BYTES) {
    throw ApiError.invalidInput(
      `That picture is ${describeBytes(size)}; the limit is ${MAX_RELEASE_NOTE_IMAGE_LABEL}.`,
    );
  }
  actorGuard().spend('release-note-image-grant', actor);

  const type = contentType.trim().toLowerCase();
  const key = mintReleaseNoteImageKey(type);
  const expiresAt = new Date(Date.now() + IMAGE_UPLOAD_GRANT_SECONDS * 1000);
  const url = await mediaStore().presignPut({
    key,
    contentType: type,
    contentLength: size,
    expiresInSeconds: IMAGE_UPLOAD_GRANT_SECONDS,
  });
  logger.info('release-note.image.granted', {
    actorId: actor.id,
    action: 'release-note.create',
    mediaKey: key,
    contentType: type,
    declaredSize: size,
  });
  return { url, key, contentType: type, expiresAt: expiresAt.toISOString() };
}
